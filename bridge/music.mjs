import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Music around the player: recommendations, synced lyrics, and a Spotify
 * login so ZEN can start songs by name.
 *
 *   recommendations  Deezer's artist radio (keyless): the artist plus similar
 *                    ones, with covers. Deezer's track search is blocked in
 *                    some regions; its artist search and radio are not.
 *   lyrics           LRCLIB synced lyrics (keyless), lyrics.ovh as fallback —
 *                    the same pair Sapphire uses.
 *   spotify login    OAuth with PKCE: only SPOTIFY_CLIENT_ID is needed, no
 *                    secret. The token stays in ~/.string/spotify.json.
 */

const T = 10_000
const json = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(T) }).then((r) => {
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`)
    return r.json()
  })

const cache = new Map()
const cached = async (key, ms, fn) => {
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.value
  const value = await fn()
  cache.set(key, { value, until: Date.now() + ms })
  if (cache.size > 300) cache.delete(cache.keys().next().value)
  return value
}

// ------------------------------------------------------------ recommendations

export function recommendations(artist, title = '') {
  const a = String(artist ?? '').trim()
  if (!a) return Promise.resolve([])
  return cached(`recs:${a.toLowerCase()}|${title.toLowerCase()}`, 10 * 60_000, async () => {
    const found = await json(`https://api.deezer.com/search/artist?limit=1&q=${encodeURIComponent(a)}`)
    const id = found.data?.[0]?.id
    if (!id) return []
    const radio = await json(`https://api.deezer.com/artist/${id}/radio?limit=25`)
    const seen = new Set([`${title}|${a}`.toLowerCase()])
    const out = []
    for (const t of radio.data ?? []) {
      const key = `${t.title}|${t.artist?.name}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title: t.title, artist: t.artist?.name ?? '', art: t.album?.cover_medium ?? null })
      if (out.length >= 8) break
    }
    return out
  })
}

// --------------------------------------------------------------------- lyrics

/** "[01:02.34] line" -> { t: 62.34, line } */
function parseLrc(lrc) {
  const out = []
  for (const raw of String(lrc).split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/)
    if (m) out.push({ t: Number(m[1]) * 60 + Number(m[2]), line: m[3] })
  }
  return out
}

export function lyrics({ artist, title, album, duration }) {
  const a = String(artist ?? '').trim()
  const t = String(title ?? '').trim()
  if (!a || !t) return Promise.resolve(null)
  return cached(`lyr:${a}|${t}`.toLowerCase(), 60 * 60_000, async () => {
    const q = new URLSearchParams({ artist_name: a, track_name: t })
    if (album) q.set('album_name', album)
    if (duration) q.set('duration', String(Math.round(duration)))
    try {
      let d = await json(`https://lrclib.net/api/get?${q}`).catch(() => null)
      // The exact match is strict about album and duration; search is not.
      if (!d) {
        const list = await json(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: a, track_name: t })}`)
        d = list.find((x) => x.syncedLyrics) ?? list[0] ?? null
      }
      if (d?.instrumental) return { instrumental: true }
      if (d?.syncedLyrics) return { synced: parseLrc(d.syncedLyrics), source: 'LRCLIB' }
      if (d?.plainLyrics) return { plain: d.plainLyrics, source: 'LRCLIB' }
    } catch {
      /* fall through to lyrics.ovh */
    }
    const o = await json(`https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`).catch(() => null)
    return o?.lyrics ? { plain: o.lyrics, source: 'lyrics.ovh' } : null
  })
}

// -------------------------------------------------------------- spotify login

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || ''
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || ''
export const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8787/callback'
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-top-read user-read-recently-played playlist-read-private'
const TOKEN_FILE = process.env.ZEN_SPOTIFY_FILE || join(homedir(), '.string', 'spotify.json')

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** state -> PKCE verifier, for logins in flight. */
const pending = new Map()

function loadToken() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}
function saveToken(t) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(`${TOKEN_FILE}.tmp`, JSON.stringify(t), { mode: 0o600 })
  renameSync(`${TOKEN_FILE}.tmp`, TOKEN_FILE)
}

export function spotifyStatus() {
  const t = loadToken()
  return { configured: Boolean(CLIENT_ID), loggedIn: Boolean(t?.refresh_token), user: t?.user ?? null }
}

/** The URL to send the browser to for "Log in with Spotify". */
export function loginUrl() {
  if (!CLIENT_ID) return null
  const verifier = b64url(randomBytes(48))
  const state = b64url(randomBytes(12))
  pending.set(state, verifier)
  setTimeout(() => pending.delete(state), 10 * 60_000)
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
  })
  return `https://accounts.spotify.com/authorize?${q}`
}

async function tokenRequest(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
    signal: AbortSignal.timeout(T),
  })
  const d = await r.json()
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || `token ${r.status}`)
  return d
}

/** The OAuth redirect lands here. Returns a short message for the page. */
export async function finishLogin(code, state) {
  const verifier = pending.get(state)
  if (!verifier) throw new Error('This login link expired. Start again from ZEN.')
  pending.delete(state)
  const d = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
  const t = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 - 60_000 }
  const me = await json('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${t.access_token}` } }).catch(() => null)
  t.user = me?.display_name ?? me?.id ?? null
  saveToken(t)
  return t.user
}

/** A usable token: the user's (refreshed as needed), else client credentials. */
async function accessToken() {
  const t = loadToken()
  if (t?.refresh_token) {
    if (Date.now() < t.expires_at) return t.access_token
    const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    const next = { ...t, access_token: d.access_token, refresh_token: d.refresh_token ?? t.refresh_token, expires_at: Date.now() + d.expires_in * 1000 - 60_000 }
    saveToken(next)
    return next.access_token
  }
  if (CLIENT_ID && CLIENT_SECRET) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(T),
    }).then((x) => x.json())
    if (r.access_token) return r.access_token
  }
  return null
}

/** First Spotify track for a query, or null if there is no way to search. */
export async function searchTrack(query) {
  const token = await accessToken()
  if (!token) return null
  const d = await json(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const t = d.tracks?.items?.[0]
  return t ? { uri: t.uri, name: t.name, artist: t.artists?.map((x) => x.name).join(', ') } : null
}

export const canSearch = () => Boolean(loadToken()?.refresh_token || (CLIENT_ID && CLIENT_SECRET))

// ------------------------------------------------------------------ for you

/**
 * Recommended for the user, not for the song: their top artists on Spotify
 * lately, each widened with Deezer's artist radio (Spotify's own
 * recommendations endpoint is closed to new apps), interleaved so no one
 * artist dominates, minus what they already play the most.
 */
export async function forYou() {
  const token = loadToken()?.refresh_token ? await accessToken() : null
  if (!token) return { needLogin: true, tracks: [] }
  return cached('foryou', 30 * 60_000, async () => {
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    const [artists, top] = await Promise.all([
      json('https://api.spotify.com/v1/me/top/artists?limit=4&time_range=short_term', auth),
      json('https://api.spotify.com/v1/me/top/tracks?limit=30&time_range=short_term', auth).catch(() => ({ items: [] })),
    ])
    const known = new Set((top.items ?? []).map((t) => `${t.name}|${t.artists?.[0]?.name}`.toLowerCase()))
    const lists = await Promise.all(
      (artists.items ?? []).map((a) => recommendations(a.name).catch(() => [])),
    )
    const out = []
    const seen = new Set()
    for (let i = 0; out.length < 10 && i < 8; i++) {
      for (const list of lists) {
        const t = list[i]
        if (!t) continue
        const k = `${t.title}|${t.artist}`.toLowerCase()
        if (seen.has(k) || known.has(k)) continue
        seen.add(k)
        out.push(t)
        if (out.length >= 10) break
      }
    }
    return { needLogin: false, basedOn: (artists.items ?? []).map((a) => a.name), tracks: out }
  })
}

/**
 * Start a track on this Mac's Spotify through the Web API — no window comes
 * forward at all. Needs Premium (Spotify refuses playback control otherwise),
 * so a false here just means "use the AppleScript path".
 */
export async function playViaApi(uri) {
  if (!loadToken()?.refresh_token) return false
  try {
    const token = await accessToken()
    const auth = { Authorization: `Bearer ${token}` }
    const devices = await json('https://api.spotify.com/v1/me/player/devices', { headers: auth })
    const mac = (devices.devices ?? []).find((d) => d.type === 'Computer') ?? devices.devices?.[0]
    if (!mac) return false
    const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(mac.id)}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
      signal: AbortSignal.timeout(10_000),
    })
    return r.status === 204 || r.status === 202 || r.ok
  } catch {
    return false
  }
}
