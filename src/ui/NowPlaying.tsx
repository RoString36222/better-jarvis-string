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
          className={`np${playing ? ' np-playing' : ''}`}
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        >
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
            <button className="np-x" onClick={() => setDismissed(key)} title="Hide until the next track">
              ✕
            </button>
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
        </motion.div>
      )}
    </AnimatePresence>
  )
}
