import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canSearch, playViaApi, searchTrack } from './music.mjs'

/**
 * Hands on the Mac — a short list of named actions, not a shell.
 *
 * A voice assistant cannot ask "are you sure?", so it does not get open-ended
 * command execution. It gets these: open an app from an allowlist, control
 * Spotify, set the volume, and keep timers and reminders. Every action is a
 * fixed AppleScript with the user's words passed as arguments (execFile, no
 * shell), so nothing said aloud can become a command. That is why these run
 * even with JARVIS_ALLOW_WRITES off.
 */

const run = (script, args = []) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 10_000 }, (err, out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(out).trim()),
    )
  })

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

// --------------------------------------------------------------------- apps

const DEFAULT_APPS = [
  'Spotify', 'Music', 'Slack', 'Safari', 'Google Chrome', 'Brave Browser', 'Opera GX', 'Arc',
  'Notes', 'Calendar', 'Reminders', 'Mail', 'Messages', 'FaceTime', 'Photos', 'Finder',
  'Terminal', 'Visual Studio Code', 'Cursor', 'Notion', 'WhatsApp', 'Telegram', 'zoom.us',
  'Microsoft Teams', 'Calculator', 'System Settings', 'Preview', 'Discord', 'Figma', 'Obsidian',
]
const APPS = (process.env.ZEN_APPS ? process.env.ZEN_APPS.split(',') : DEFAULT_APPS).map((a) => a.trim())

/** "chrome" -> "Google Chrome", "vs code" -> "Visual Studio Code". */
const ALIASES = { chrome: 'Google Chrome', brave: 'Brave Browser', 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', code: 'Visual Studio Code', zoom: 'zoom.us', teams: 'Microsoft Teams', settings: 'System Settings', opera: 'Opera GX' }

function resolveApp(name) {
  const want = String(name ?? '').trim().toLowerCase().replace(/\.app$/, '')
  const canonical = ALIASES[want] ?? APPS.find((a) => a.toLowerCase() === want)
  if (!canonical) return null
  const installed = ['/Applications', '/System/Applications', join(homedir(), 'Applications')].some((d) =>
    existsSync(join(d, `${canonical}.app`)),
  )
  return installed ? canonical : null
}

// ------------------------------------------------------------------ spotify

const SPOTIFY = (cmd) => `tell application "Spotify" to ${cmd}`

/**
 * Spotify running but out of sight. `open -gj` launches it in the background
 * and hidden, so "play" never pulls its window over ZEN; the player in ZEN is
 * the interface.
 */
export async function spotifyInBackground() {
  const running = await run('application "Spotify" is running').catch(() => 'false')
  if (running === 'true') return
  await new Promise((resolve) => execFile('open', ['-gj', '-a', 'Spotify'], () => resolve()))
  for (let i = 0; i < 40; i++) {
    if ((await run('application "Spotify" is running').catch(() => 'false')) === 'true') break
    await new Promise((r) => setTimeout(r, 250))
  }
  // Freshly launched, it needs a moment before it accepts play commands.
  await new Promise((r) => setTimeout(r, 1500))
}

/** Put Spotify's window away again; loading a track brings it forward. */
const hideSpotify = () =>
  run('tell application "System Events" to set visible of process "Spotify" to false').catch(() => {})

const isPlaying = async () =>
  (await run('tell application "Spotify" to return (player state as string)').catch(() => '')) === 'playing'

/** What "play some music" starts when nothing is queued. Public, works on free accounts. */
const DEFAULT_PLAYLIST = process.env.ZEN_DEFAULT_PLAYLIST || 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'

/**
 * Starts a track or playlist and makes sure it is actually playing. Spotify
 * 1.3 loads a URI paused and pops its window, so: load, play, hide, check.
 */
export async function playUri(uri) {
  // Premium: start it remotely, nothing on screen moves.
  if (await playViaApi(uri)) {
    await new Promise((r) => setTimeout(r, 900))
    if (await isPlaying()) return true
  }
  // Otherwise AppleScript, which brings Spotify forward. Remember who was in
  // front (ZEN) and hand focus straight back after hiding Spotify — hiding
  // alone let macOS give focus to some other app and bury ZEN.
  const front = await run(
    'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
  ).catch(() => '')
  await run('on run argv\ntell application "Spotify" to play track (item 1 of argv)\nend run', [uri])
  await new Promise((r) => setTimeout(r, 700))
  if (!(await isPlaying())) await run(SPOTIFY('play')).catch(() => {})
  await hideSpotify()
  if (front && front !== 'com.spotify.client') {
    await run('on run argv\ntell application id (item 1 of argv) to activate\nend run', [front]).catch(() => {})
  }
  await new Promise((r) => setTimeout(r, 600))
  return isPlaying()
}

/** Finds a track with Spotify search: the user's login, or id+secret. */
const spotifyTrack = (query) => searchTrack(query)

/**
 * What Spotify is doing, for the on-screen player. Null when Spotify is not
 * running (asked first, so polling never launches it).
 */
export async function spotifyState() {
  if (!resolveApp('Spotify')) return null
  const running = await run('application "Spotify" is running').catch(() => 'false')
  if (running !== 'true') return null
  // A full tell block: the one-line "tell … to" form takes one statement, and
  // with several it failed every time — which read as "stopped".
  const out = await run(`tell application "Spotify"
      if player state is stopped then return "stopped"
      set t to current track
      return (player state as string) & "|||" & (name of t) & "|||" & (artist of t) & "|||" & (album of t) & "|||" & (artwork url of t) & "|||" & (duration of t) & "|||" & (player position)
    end tell`).catch(() => 'stopped')
  if (out === 'stopped') return { state: 'stopped' }
  const [state, title, artist, album, art, durationMs, position] = out.split('|||')
  return {
    state,
    title,
    artist,
    album,
    art: /^https:\/\//.test(art) ? art : null,
    duration: Number(durationMs) / 1000,
    position: Number(String(position).replace(',', '.')),
  }
}

/**
 * Spotify's own volume, lowered while the user talks to ZEN and while ZEN
 * answers, so the microphone hears the user rather than the song. Restored to
 * exactly where it was. Only touches Spotify if it is running and playing.
 */
let duckedFrom = null
export async function spotifyDuck(on) {
  try {
    if (!resolveApp('Spotify')) return
    if ((await run('application "Spotify" is running').catch(() => 'false')) !== 'true') return
    if (on) {
      if (duckedFrom !== null || !(await isPlaying())) return
      const v = Number(await run(SPOTIFY('get sound volume')))
      if (!Number.isFinite(v)) return
      duckedFrom = v
      await run(SPOTIFY(`set sound volume ${Math.max(4, Math.round(v * 0.15))}`))
    } else if (duckedFrom !== null) {
      const back = duckedFrom
      duckedFrom = null
      await run(SPOTIFY(`set sound volume ${back}`))
    }
  } catch {
    /* ducking is a nicety */
  }
}

/** Player buttons: play/pause/next/previous, or seek to `position` seconds. */
export async function spotifyControl(action, position) {
  if (!resolveApp('Spotify')) throw new Error('Spotify is not installed')
  if (action === 'seek') {
    const p = Math.max(0, Number(position) || 0)
    return run(`on run argv\ntell application "Spotify" to set player position to (item 1 of argv as real)\nend run`, [String(p)])
  }
  const cmd = { toggle: 'playpause', play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' }[action]
  if (!cmd) throw new Error(`unknown action ${action}`)
  return run(SPOTIFY(cmd))
}

// ---------------------------------------------------------------- reminders

const FILE = process.env.ZEN_REMINDERS_FILE || join(homedir(), '.string', 'reminders.json')

/** @returns {{ id: string, text: string, due: number }[]} */
function loadReminders() {
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(d) ? d : []
  } catch {
    return []
  }
}
function saveReminders(items) {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(`${FILE}.tmp`, JSON.stringify(items, null, 1))
  renameSync(`${FILE}.tmp`, FILE)
}

/** "16:00", "4pm", "4:30 pm" -> the next such time today or tomorrow. */
function parseClock(at, now = new Date()) {
  const m = String(at).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) {
    const t = Date.parse(at)
    return Number.isFinite(t) ? t : null
  }
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  // "at 4" with no am/pm during the working day means the afternoon.
  if (!m[3] && h >= 1 && h <= 7) h += 12
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

const sayTime = (t) =>
  new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })

/**
 * Fires due reminders: a macOS notification always (so it reaches you with no
 * ZEN window open), and `onFire` so open pages can say it aloud.
 */
export function startReminderClock(onFire) {
  const tick = () => {
    const items = loadReminders()
    const now = Date.now()
    const due = items.filter((r) => r.due <= now)
    if (!due.length) return
    saveReminders(items.filter((r) => r.due > now))
    for (const r of due) {
      run(
        'on run argv\ndisplay notification (item 1 of argv) with title "ZEN" sound name "Glass"\nend run',
        [r.text],
      ).catch(() => {})
      onFire(r)
    }
  }
  tick()
  return setInterval(tick, 5000)
}

export const reminderCount = () => loadReminders().length

// ------------------------------------------------------------------- server

/** Asked for by name, these open as ZEN's own terminal window instead. */
const TERMINALS = /^(terminal|kitty|iterm2?|warp|alacritty|ghostty|wezterm|shell|the terminal|a terminal|console)$/i

export function macServer({ openTerminal } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_mac',
    version: '1.0.0',
    tools: [
      tool(
        'open_app',
        `Open (or bring to front) an app on the user's Mac. Allowed: ${APPS.join(', ')}. ` +
          'Terminal, kitty, iTerm and other terminals open INSIDE ZEN as a window instead — pass "terminal".',
        {
          app: z.string().describe('App name, e.g. "Spotify", "Slack", "Chrome", or "terminal".'),
          run: z
            .enum(['claude', 'python', 'node', 'top', 'htop', 'btop', 'vim', 'nvim', 'lazygit'])
            .optional()
            .catch(undefined)
            .describe(
              'Terminal only: a program to start in it. "claude" = Claude Code. Only these names; ' +
                'you cannot type other commands into the terminal.',
            ),
        },
        async ({ app, run }) => {
          if (openTerminal && TERMINALS.test(String(app ?? '').trim())) {
            openTerminal(run)
            return ok(
              run
                ? `Opened a terminal inside ZEN and started ${run === 'claude' ? 'Claude Code' : run} in it. It is the user's to use from here.`
                : 'Opened a terminal inside ZEN (left half of the screen).',
            )
          }
          const name = resolveApp(app)
          if (!name) return fail(`"${app}" is not an app I can open (allowed: ${APPS.join(', ')}), or it is not installed.`)
          await run('on run argv\ntell application (item 1 of argv) to activate\nend run', [name])
          return ok(`Opened ${name}.`)
        },
      ),
      tool(
        'spotify',
        'Control Spotify in the background (it is launched hidden if needed, never brought ' +
          'to the front; ZEN shows its own player): play/resume, pause, next, previous, or what is playing now. ' +
          '"Play Spotify" or "play some music" with no song named = play.',
        { action: z.enum(['play', 'pause', 'toggle', 'next', 'previous', 'now_playing']) },
        async ({ action }) => {
          if (!resolveApp('Spotify')) return fail('Spotify is not installed.')
          if (action === 'now_playing') {
            const out = await run(
              SPOTIFY('if player state is playing then return (name of current track) & " by " & (artist of current track)\nreturn "nothing"'),
            ).catch(() => 'nothing')
            return ok(out === 'nothing' ? 'Nothing is playing.' : `Playing ${out}.`)
          }
          const cmd = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', previous: 'previous track' }[action]
          if (action !== 'pause') await spotifyInBackground()
          await run(SPOTIFY(cmd))
          if (action === 'play' || action === 'toggle') {
            await new Promise((r) => setTimeout(r, 900))
            if (action === 'play' && !(await isPlaying())) {
              // Nothing queued to resume: start something rather than nothing.
              if (!(await playUri(DEFAULT_PLAYLIST))) return fail('Spotify would not start playing.')
              return ok('Nothing was queued, so I started Today\'s Top Hits. The player is on screen.')
            }
            await hideSpotify()
          }
          return ok(`Done: ${action}.`)
        },
      ),
      tool(
        'play_song',
        'Play a song, artist or album on Spotify. Say what to play in plain words.',
        { query: z.string().describe('e.g. "Blinding Lights by The Weeknd", "lofi hip hop"') },
        async ({ query }) => {
          if (!resolveApp('Spotify')) return fail('Spotify is not installed.')
          const q = String(query ?? '').trim()
          if (!q) return fail('Nothing to play.')
          if (!canSearch()) {
            // Never fall back to opening Spotify's window: the user wants the
            // music in the background and the player in ZEN, not a jump to the app.
            return fail(
              'Playing a specific song needs Spotify search, which is not set up: the user ' +
                'adds SPOTIFY_CLIENT_ID to .kimi.env and presses "Log in with Spotify" on the ' +
                'player. Say so briefly. Resume, pause and next still work.',
            )
          }
          const track = await spotifyTrack(q).catch(() => null)
          if (!track) return fail(`Nothing on Spotify matched "${q}".`)
          await spotifyInBackground()
          if (!(await playUri(track.uri))) return fail(`Found ${track.name} but Spotify would not start it.`)
          return ok(`Playing ${track.name} by ${track.artist}. The player is on screen.`)
        },
      ),
      tool(
        'volume',
        'Set or nudge the Mac output volume.',
        {
          action: z.enum(['set', 'up', 'down', 'mute', 'unmute']),
          level: z.number().min(0).max(100).optional().catch(undefined).describe('0-100, for "set".'),
        },
        async ({ action, level }) => {
          const cur = Number(await run('output volume of (get volume settings)'))
          if (action === 'mute' || action === 'unmute') {
            await run(`set volume output muted ${action === 'mute'}`)
            return ok(action === 'mute' ? 'Muted.' : 'Unmuted.')
          }
          const next = action === 'set' ? (level ?? cur) : Math.max(0, Math.min(100, cur + (action === 'up' ? 15 : -15)))
          await run(`set volume output volume ${Math.round(next)}`)
          return ok(`Volume ${Math.round(next)}%.`)
        },
      ),
      tool(
        'set_reminder',
        'Set a timer or reminder. ZEN says it aloud and shows a Mac notification when due. ' +
          'Give `minutes` for "in 20 minutes" / "a 5 minute timer", or `at` for a clock time ("16:00", "4:30pm").',
        {
          text: z.string().describe('What to remind them, e.g. "Check the deploy". For a timer: "Your 5 minute timer is done".'),
          minutes: z.number().positive().optional().catch(undefined),
          at: z.string().optional().catch(undefined),
        },
        async ({ text, minutes, at }) => {
          const due = minutes ? Date.now() + minutes * 60_000 : at ? parseClock(at) : null
          if (!due) return fail('When? Give minutes from now or a clock time.')
          const items = loadReminders()
          const id = `r${Date.now().toString(36)}`
          items.push({ id, text: String(text).trim() || 'Reminder', due })
          saveReminders(items)
          return ok(`Set (${id}) for ${sayTime(due)}.`)
        },
      ),
      tool('list_reminders', 'List pending timers and reminders.', {}, async () => {
        const items = loadReminders().sort((a, b) => a.due - b.due)
        return ok(items.length ? items.map((r) => `${r.id}: ${r.text} at ${sayTime(r.due)}`).join('\n') : 'No reminders.')
      }),
      tool(
        'cancel_reminder',
        'Cancel a reminder by id (from list_reminders), or "all".',
        { id: z.string() },
        async ({ id }) => {
          const items = loadReminders()
          const keep = id === 'all' ? [] : items.filter((r) => r.id !== id)
          if (keep.length === items.length) return fail(`No reminder ${id}.`)
          saveReminders(keep)
          return ok(`Cancelled ${items.length - keep.length}.`)
        },
      ),
    ],
  })
}
