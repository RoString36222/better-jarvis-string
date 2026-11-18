/**
 * ZEN Notch: the small arc beside the Mac's notch (see notch/ in the repo).
 *
 * When the ZEN window is hidden it drops its whole 3D scene to save the GPU,
 * so something else has to show that ZEN is still there — listening, thinking,
 * waiting on an Allow card — and let the user answer without bringing the
 * window back. That is the notch app, and this module is its side of the
 * bridge: one WebSocket path, /notch, that only ever *reads* ZEN's state and
 * answers the handful of things the notch is allowed to answer.
 *
 * What the notch can do is deliberately narrow. It cannot ask the agent
 * anything or see the conversation; it gets a short caption, the phase, what
 * Spotify is playing, ZEN's spoken alerts, and pending Allow cards. It can
 * reply to a card, press a player button, or ask for the window. That is why a
 * no-origin client is acceptable here (from loopback only) when it is refused
 * on the main socket: the worst a stray local process can do through /notch is
 * what a click in the notch can do.
 *
 * Frames to the notch:
 *   {type:'state', phase, caption, windowOpen}   phase: idle|listening|thinking|speaking|offline
 *   {type:'music', title, artist, album, art, playing, duration, position}  every ~2s while playing, and on any change
 *   {type:'notify', text}                        ZEN spoke up on its own (reminders, chief)
 *   {type:'approve', id, text}                   an Allow/Deny card is waiting
 *   {type:'approve-done', id}                    that card was answered (anywhere) or expired
 * Frames from the notch:
 *   {type:'reply', id, ok} · {type:'music', op, position?} · {type:'open'}
 */
import { spotifyControl, spotifyState } from './mac.mjs'

const PHASES = new Set(['idle', 'listening', 'thinking', 'speaking', 'offline'])
const MUSIC_OPS = new Set(['play', 'pause', 'toggle', 'next', 'previous', 'seek'])

/**
 * How long a card waits before it is offered to the notch. Most cards are
 * answered by ZEN itself in a few milliseconds (inside an "Allow next 2 min"
 * window), and offering those would flash an Allow card in the notch for a
 * question nobody has to answer. A quarter second is invisible to a person.
 */
const OFFER_DELAY_MS = 250

/** Spotify is asked over AppleScript, which costs a process spawn: often while
 *  something is playing (the notch shows it), rarely otherwise. */
const MUSIC_PLAYING_MS = 2000
const MUSIC_IDLE_MS = 5000

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
export const isLoopback = (addr) => LOOPBACK.has(String(addr ?? ''))

/** Captions are for a 300pt-wide panel, not a transcript. */
const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * @param {{ showWindow: () => void }} deps  showWindow asks every ZEN page to
 *   come forward (the desktop app turns that into win.show()).
 */
export function createNotchHub({ showWindow }) {
  /** Open notch sockets. Not in the server's `everyone`: they are not pages. */
  const notches = new Set()
  /** Each connected ZEN page's last report, keyed by its send(). */
  const renderers = new Map()
  /** Cards on offer to the notch, by notch id. */
  const cards = new Map()
  let seq = 0
  let lastState = ''
  let lastMusic = null
  let lastMusicKey = ''
  let lastNotify = null
  let musicTimer = null
  let polling = false

  const sendTo = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const broadcast = (msg) => {
    for (const ws of notches) sendTo(ws, msg)
  }

  /**
   * One ZEN for the notch, even with a browser tab and the desktop window both
   * connected: the page that reported most recently speaks for the phase (it
   * is the one the user is talking to), and the window counts as open if any
   * page is on screen.
   */
  function currentState() {
    let best = null
    for (const r of renderers.values()) if (!best || r.at > best.at) best = r
    if (!best) return { type: 'state', phase: 'offline', caption: '', windowOpen: false }
    const windowOpen = [...renderers.values()].some((r) => r.windowOpen)
    return { type: 'state', phase: best.phase, caption: best.caption, windowOpen }
  }

  /** Only real changes go out: a page reports on every caption token. */
  function pushState(force = false) {
    const st = currentState()
    const key = JSON.stringify(st)
    if (!force && key === lastState) return
    lastState = key
    broadcast(st)
  }

  // ------------------------------------------------------------------ music

  async function pollMusic() {
    if (polling) return
    polling = true
    let playing = false
    try {
      const st = await spotifyState().catch(() => null)
      const msg =
        st && st.state && st.state !== 'stopped' && st.title
          ? {
              type: 'music',
              title: st.title,
              artist: st.artist ?? '',
              album: st.album ?? '',
              art: st.art ?? null,
              playing: st.state === 'playing',
              // Seconds; the notch runs its own clock between updates.
              duration: Number.isFinite(st.duration) ? st.duration : null,
              position: Number.isFinite(st.position) ? st.position : null,
            }
          : { type: 'music', title: null, artist: null, art: null, playing: false }
      playing = msg.playing
      const key = JSON.stringify(msg)
      // Every poll while playing (the notch keeps its "live" look fresh and a
      // reconnecting notch never waits long); otherwise only when it changes.
      if (playing || key !== lastMusicKey) broadcast(msg)
      lastMusic = msg
      lastMusicKey = key
    } finally {
      polling = false
    }
    return playing
  }

  /** Polls only while a notch is listening — no notch, no AppleScript. */
  function scheduleMusic(delay) {
    clearTimeout(musicTimer)
    musicTimer = null
    if (!notches.size) return
    musicTimer = setTimeout(async () => {
      const playing = await pollMusic()
      scheduleMusic(playing ? MUSIC_PLAYING_MS : MUSIC_IDLE_MS)
    }, delay)
  }

  // -------------------------------------------------------------- the notch

  function handle(socket, req) {
    console.log(`[zen] notch connected from ${req.socket.remoteAddress}`)
    notches.add(socket)
    // Everything the notch needs to draw, straight away, so a notch that
    // started after ZEN (or reconnected) is never blank or behind.
    sendTo(socket, currentState())
    if (lastMusic) sendTo(socket, lastMusic)
    if (lastNotify) sendTo(socket, { type: 'notify', text: lastNotify })
    for (const [id, c] of cards) sendTo(socket, { type: 'approve', id, text: c.text })
    scheduleMusic(notches.size === 1 ? 0 : MUSIC_PLAYING_MS)

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg?.type === 'reply' && typeof msg.id === 'string') {
        // The first answer wins; a card already answered in the window is gone.
        cards.get(msg.id)?.answer(msg.ok === true)
      } else if (msg?.type === 'music' && MUSIC_OPS.has(msg.op)) {
        // Seek carries the new position in seconds (the notch's timeline); a
        // value that is not a sane number is dropped rather than sent to Spotify.
        const at = Number(msg.position)
        if (msg.op === 'seek' && !(Number.isFinite(at) && at >= 0 && at < 24 * 3600)) return
        console.log(`[zen] notch music ${msg.op}${msg.op === 'seek' ? ` ${at.toFixed(1)}s` : ''}`)
        void spotifyControl(msg.op, at)
          .catch((err) => console.warn('[zen] notch music failed:', err?.message ?? err))
          // Show the new track as soon as Spotify has it, not on the next tick.
          .finally(() => scheduleMusic(350))
      } else if (msg?.type === 'open') {
        console.log('[zen] notch asked for the window')
        showWindow()
      }
    })
    socket.on('close', () => {
      notches.delete(socket)
      if (!notches.size) scheduleMusic(0) // clears the timer
      console.log('[zen] notch disconnected')
    })
    socket.on('error', () => {})
  }

  // ------------------------------------------------------- the ZEN pages

  function rendererJoined(send) {
    renderers.set(send, { phase: 'idle', caption: '', windowOpen: true, at: Date.now() })
    pushState()
  }
  function rendererLeft(send) {
    renderers.delete(send)
    pushState()
  }
  /** A page's {type:'phase'} frame. Anything malformed is ignored, not trusted. */
  function rendererPhase(send, msg) {
    const r = renderers.get(send)
    if (!r || !PHASES.has(msg?.phase)) return
    r.phase = msg.phase
    r.caption = short(msg.caption)
    if (typeof msg.windowOpen === 'boolean') r.windowOpen = msg.windowOpen
    r.at = Date.now()
    pushState()
  }

  function notify(text) {
    lastNotify = short(text, 400)
    broadcast({ type: 'notify', text: lastNotify })
  }

  /**
   * Offer an Allow card to every notch. `answer(ok)` is called with the first
   * notch answer; the returned close() takes the card back (answered in the
   * window, answered here, or timed out) and tells every notch to dismiss it.
   */
  function offer(text, answer) {
    const id = `n${++seq}`
    let closed = false
    const show = setTimeout(() => {
      if (closed) return
      cards.set(id, { text: String(text ?? ''), answer })
      broadcast({ type: 'approve', id, text: String(text ?? '') })
    }, OFFER_DELAY_MS)
    return () => {
      if (closed) return
      closed = true
      clearTimeout(show)
      if (cards.delete(id)) broadcast({ type: 'approve-done', id })
    }
  }

  return { handle, rendererJoined, rendererLeft, rendererPhase, notify, offer }
}
