import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The music player: what Spotify is playing, with seek and transport, drawn
 * as part of the HUD.
 *
 * It reads Spotify through the bridge (GET /media) about once a second and
 * interpolates the position in between, so the bar moves smoothly without
 * hammering AppleScript. It appears whenever something is playing — "play
 * some lofi" puts it up — and the ✕ hides it until the next track.
 */

type Media = {
  state: 'playing' | 'paused' | 'stopped'
  title?: string
  artist?: string
  album?: string
  art?: string | null
  duration?: number
  position?: number
}

const POLL_MS = 1000

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

const control = (action: string, position?: number) =>
  fetch(`${BRIDGE_HTTP_URL}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, position }),
  }).catch(() => {})

export function NowPlaying() {
  const [media, setMedia] = useState<Media | null>(null)
  const [pos, setPos] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [showLyrics, setShowLyrics] = useState(() => {
    try {
      return localStorage.getItem('zen.lyrics') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('zen.lyrics', showLyrics ? '1' : '0')
    } catch {
      /* storage blocked */
    }
  }, [showLyrics])
  /** Where the last poll put us, and when — for smooth interpolation. */
  const anchor = useRef({ position: 0, at: 0, playing: false })
  const bar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    let timer = 0
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await fetch(`${BRIDGE_HTTP_URL}/media`, { cache: 'no-store' })
          const m = (r.ok ? await r.json() : null) as Media | null
          if (!alive) return
          setMedia(m)
          if (m?.position !== undefined) {
            anchor.current = { position: m.position, at: performance.now(), playing: m.state === 'playing' }
          }
        } catch {
          /* bridge restarting — try again next tick */
        }
      }
      if (alive) timer = window.setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // Smooth position between polls.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const a = anchor.current
      setPos(a.playing ? a.position + (performance.now() - a.at) / 1000 : a.position)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const key = media?.title ? `${media.title}|${media.artist}` : null
  const show = Boolean(media && media.state !== 'stopped' && key && key !== dismissed)
  const duration = media?.duration ?? 0
  const shown = Math.min(dragging ?? pos, duration || Infinity)
  const pct = duration ? (shown / duration) * 100 : 0
  const playing = media?.state === 'playing'

  const seekFrom = (clientX: number) => {
    const box = bar.current?.getBoundingClientRect()
    if (!box || !duration) return null
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration
  }

  const onBarDown = (e: React.PointerEvent) => {
    const t = seekFrom(e.clientX)
    if (t === null) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(t)
  }
  const onBarMove = (e: React.PointerEvent) => {
    if (dragging === null) return
    const t = seekFrom(e.clientX)
    if (t !== null) setDragging(t)
  }
  const onBarUp = () => {
    if (dragging === null) return
    anchor.current = { position: dragging, at: performance.now(), playing }
    void control('seek', dragging)
    setDragging(null)
  }

  const act = (action: 'toggle' | 'next' | 'previous') => {
    if (action === 'toggle') {
      // Flip it locally at once; the next poll confirms.
      anchor.current = { position: pos, at: performance.now(), playing: !playing }
      setMedia((m) => (m ? { ...m, state: playing ? 'paused' : 'playing' } : m))
    }
    void control(action)
  }

  return (
    <AnimatePresence>
      {show && media && (
        <motion.div
          className="np-dock"
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        >
          {showLyrics && <Lyrics media={media} position={shown} />}
          <Recs media={media} />
          <div className={`np${playing ? ' np-playing' : ''}`}>
          <span className="pk pk-tl" />
          <span className="pk pk-tr" />
          <span className="pk pk-bl" />
          <span className="pk pk-br" />

          <div className="np-head">
            <span className="np-kicker">
              <span className="np-eq" aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
              {playing ? 'NOW PLAYING' : 'PAUSED'} · SPOTIFY
            </span>
            <span className="np-acts">
              <button
                className={`np-tag${showLyrics ? ' np-tag-on' : ''}`}
                onClick={() => setShowLyrics((v) => !v)}
                title="Synced lyrics"
              >
                LYRICS
              </button>
              <button className="np-x" onClick={() => setDismissed(key)} title="Hide until the next track">
                ✕
              </button>
            </span>
          </div>

          <div className="np-body">
            {media.art ? (
              // Through the bridge's image proxy: the page's CSP only admits
              // images from the bridge, and Spotify's art lives on its CDN.
              <img className="np-art" src={`${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(media.art)}`} alt="" />
            ) : (
              <div className="np-art np-art-empty">♪</div>
            )}
            <div className="np-meta">
              <div className="np-title" title={media.title}>
                {media.title}
              </div>
              <div className="np-artist" title={media.artist}>
                {media.artist}
              </div>
              {media.album && <div className="np-album">{media.album}</div>}
            </div>
          </div>

          <div
            className="np-bar"
            ref={bar}
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={() => setDragging(null)}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(shown)}
          >
            <div className="np-fill" style={{ width: `${pct}%` }} />
            <div className="np-knob" style={{ left: `${pct}%` }} />
          </div>
          <div className="np-times">
            <span>{fmt(shown)}</span>
            <span>-{fmt(duration - shown)}</span>
          </div>

          <div className="np-ctl">
            <button onClick={() => act('previous')} title="Previous" aria-label="Previous">
              <svg viewBox="0 0 24 24">
                <path d="M6 5h2v14H6zM20 5v14L9 12z" />
              </svg>
            </button>
            <button className="np-main" onClick={() => act('toggle')} title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}>
              <svg viewBox="0 0 24 24">{playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}</svg>
            </button>
            <button onClick={() => act('next')} title="Next" aria-label="Next">
              <svg viewBox="0 0 24 24">
                <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
              </svg>
            </button>
          </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ------------------------------------------------------------------- lyrics

type LyricLine = { t: number; line: string }
type LyricsDoc = { synced?: LyricLine[]; plain?: string; instrumental?: boolean; source?: string } | null

/**
 * Synced lyrics, karaoke-style: the current line lit, its neighbours fading.
 * Falls back to plain lyrics (scrollable) when no timings exist.
 */
function Lyrics({ media, position }: { media: Media; position: number }) {
  const [doc, setDoc] = useState<LyricsDoc | 'loading'>('loading')
  const list = useRef<HTMLDivElement>(null)
  const key = `${media.title}|${media.artist}`

  useEffect(() => {
    let alive = true
    setDoc('loading')
    const q = new URLSearchParams({
      artist: media.artist ?? '',
      title: media.title ?? '',
      album: media.album ?? '',
      duration: String(Math.round(media.duration ?? 0)),
    })
    fetch(`${BRIDGE_HTTP_URL}/music/lyrics?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LyricsDoc) => alive && setDoc(d))
      .catch(() => alive && setDoc(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const lines = doc && doc !== 'loading' ? doc.synced : undefined
  // A hair early: a line should light as it is sung, not after.
  const at = lines ? Math.max(0, lines.findLastIndex((l) => l.t <= position + 0.25)) : -1

  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [at])

  return (
    <div className="np-panel np-lyrics">
      <div className="np-panel-head">LYRICS{doc && doc !== 'loading' && doc.source ? ` · ${doc.source}` : ''}</div>
      <div className="np-lyr-body" ref={list}>
        {doc === 'loading' && <p className="np-dim">Finding lyrics…</p>}
        {doc === null && <p className="np-dim">No lyrics found for this one.</p>}
        {doc && doc !== 'loading' && doc.instrumental && <p className="np-dim">Instrumental.</p>}
        {lines?.map((l, i) => (
          <p key={i} data-i={i} className={`np-lyr${i === at ? ' np-lyr-now' : i < at ? ' np-lyr-past' : ''}`}>
            {l.line || '♪'}
          </p>
        ))}
        {doc && doc !== 'loading' && !lines && doc.plain && <pre className="np-lyr-plain">{doc.plain}</pre>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------- recommendations

type Rec = { title: string; artist: string; art: string | null }

/**
 * Up next: songs in the orbit of what is playing (Deezer's artist radio).
 * Tapping one plays it in Spotify, in the background — which needs the
 * Spotify login, offered right here when it is missing.
 */
function Recs({ media }: { media: Media }) {
  const [recs, setRecs] = useState<Rec[]>([])
  const [login, setLogin] = useState<{ configured: boolean; loggedIn: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const key = `${media.title}|${media.artist}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('zen.upnext.collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('zen.upnext.collapsed', c ? '0' : '1')
      } catch {
        /* storage blocked */
      }
      return !c
    })

  useEffect(() => {
    let alive = true
    const q = new URLSearchParams({ artist: media.artist ?? '', title: media.title ?? '' })
    fetch(`${BRIDGE_HTTP_URL}/music/recs?${q}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Rec[]) => alive && setRecs(Array.isArray(d) ? d : []))
      .catch(() => alive && setRecs([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const refreshLogin = () =>
    fetch(`${BRIDGE_HTTP_URL}/spotify/status`)
      .then((r) => r.json())
      .then(setLogin)
      .catch(() => {})
  // Re-checked on every track and whenever the window comes back, not just
  // once: a login finished in another tab has to clear the button here too.
  useEffect(() => {
    void refreshLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    const again = () => void refreshLogin()
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])

  const play = async (r: Rec) => {
    setBusy(r.title)
    setNote('')
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/music/play`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: r.title, artist: r.artist }),
      })
      if (res.status === 409) {
        await refreshLogin()
        setNote('Log in with Spotify to play picks.')
      } else if (!res.ok) {
        setNote(`Couldn't find “${r.title}” on Spotify.`)
      }
    } finally {
      setBusy(null)
    }
  }

  const startLogin = () => {
    window.open(`${BRIDGE_HTTP_URL}/spotify/login`, '_blank', 'width=520,height=720')
    // Pick the new login up when it lands, for the next two minutes.
    let n = 0
    const t = setInterval(() => {
      void refreshLogin()
      if (++n > 40) clearInterval(t)
    }, 3000)
  }

  if (!recs.length) return null
  return (
    <div className={`np-panel np-recs${collapsed ? ' np-collapsed' : ''}`}>
      <button className="np-panel-head np-collapse" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Show' : 'Hide'}>
        <span>UP NEXT · LIKE {String(media.artist ?? '').toUpperCase()}</span>
        <span className="np-chev">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
      <>
      <div className="np-recs-list">
        {recs.map((r) => (
          <button key={`${r.title}|${r.artist}`} className="np-rec" onClick={() => void play(r)} disabled={busy !== null}>
            {r.art ? (
              <img src={`${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(r.art)}`} alt="" />
            ) : (
              <span className="np-rec-noart">♪</span>
            )}
            <span className="np-rec-meta">
              <span className="np-rec-title">{r.title}</span>
              <span className="np-rec-artist">{r.artist}</span>
            </span>
            <span className="np-rec-play">{busy === r.title ? '…' : '▶'}</span>
          </button>
        ))}
      </div>
      {login && !login.loggedIn && (
        <div className="np-login">
          {login.configured ? (
            <button className="tb-btn" onClick={startLogin}>
              LOG IN WITH SPOTIFY
            </button>
          ) : (
            <span className="np-dim">Add SPOTIFY_CLIENT_ID to .kimi.env to play picks</span>
          )}
        </div>
      )}
      {note && <div className="np-note">{note}</div>}
      </>
      )}
    </div>
  )
}
