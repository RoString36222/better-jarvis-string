import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore, type Phase } from './store'
import { isWindowOpen, onWindowChange, useWindowOpen } from './lib/windowState'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { instantAnswer } from './lib/instant'
import { askFast, recordExchange, forAgent, type Heard } from './lib/fastlane'
import { currentSettings } from './lib/settings'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE, BRIDGE_HTTP_URL } from './config'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchNotify,
  watchApprove,
  watchCapture,
  watchUi,
  watchConnection,
  reportPhase,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * ZEN Notch shows five states, not eight: the arc only has to say whether ZEN
 * is resting, hearing, working or talking. 'offline' here means not powered on
 * yet (waiting for the click that unlocks audio) — dim, like a bridge that is
 * down, because in both cases ZEN will not answer "Hey Zen".
 */
const NOTCH_PHASE: Record<Phase, 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline'> = {
  offline: 'offline',
  boot: 'idle',
  dormant: 'idle',
  waking: 'listening',
  listening: 'listening',
  thinking: 'thinking',
  tooling: 'thinking',
  speaking: 'speaking',
}

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000
/** Push-to-talk: how long one Space press waits for you to start speaking. */
const PTT_AWAIT_MS = 8000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */

/** What the BRIEF button and the morning briefing ask. */
const BRIEFING_PROMPT =
  'Give me my briefing: use `briefing` for my day (calendar, messages that need me, ' +
  'who is waiting on me, promises and tasks due), plus today\'s weather and, if you have ' +
  'monitoring tools, whether anything is firing. Four short sentences at most.'

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:zen|zenn|xen|zan|string|strings|sting|strung|stringy|jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const windowOpen = useWindowOpen()
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  // Spotify down while the user talks to ZEN and while ZEN answers, so the
  // mic hears the user, not the song; back up when ZEN returns to rest.
  useEffect(() => {
    const ACTIVE = new Set(['waking', 'listening', 'thinking', 'tooling', 'speaking'])
    let ducked = false
    return store.subscribe((st) => {
      const want = ACTIVE.has(st.phase)
      if (want === ducked) return
      ducked = want
      void fetch(`${BRIDGE_HTTP_URL}/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'duck', on: want }),
      }).catch(() => {})
    })
  }, [])

  /** Alerts that arrived while the window was hidden (the Dock badge). */
  const unseen = useRef(0)
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || !unseen.current) return
      unseen.current = 0
      document.title = 'Z.E.N.'
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  /**
   * Tell the bridge what ZEN is doing, for ZEN Notch's arc. Captions change on
   * every streamed token, so reports are coalesced to one per 250ms; a phase or
   * window change goes out at once, since that is what the arc animates on.
   */
  useEffect(() => {
    let sent = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const report = () => {
      timer = null
      const st = store.getState()
      const p = {
        phase: NOTCH_PHASE[st.phase],
        caption: st.caption.slice(0, 120),
        windowOpen: isWindowOpen(),
      }
      const key = JSON.stringify(p)
      if (key === sent) return
      sent = key
      reportPhase(p)
    }
    let lastPhase = store.getState().phase
    const soon = () => {
      const ph = store.getState().phase
      if (ph !== lastPhase) {
        lastPhase = ph
        if (timer) clearTimeout(timer)
        return report()
      }
      if (!timer) timer = setTimeout(report, 250)
    }
    report()
    const offStore = store.subscribe(soon)
    const offWindow = onWindowChange(report)
    return () => {
      offStore()
      offWindow()
      if (timer) clearTimeout(timer)
    }
  }, [])

  /**
   * Hidden, the camera has nobody to show anything to: hand tracking stops
   * (and with it the camera light). It is not restarted on show — turning a
   * camera on is always the user's call (G), never the interface's.
   */
  useEffect(() => {
    if (windowOpen) return
    if (store.getState().gestures) {
      hands.disableHands()
      store.getState().setGestures(false)
    }
  }, [windowOpen])

  /**
   * After an answer: keep listening for a follow-up — unless push-to-talk is
   * on, where the mic only ever opens on Space. Otherwise the follow-up window
   * reopened it after every answer and the room got in again.
   */
  const followUp = () => {
    const st = currentSettings()
    if (!st.wakeWord || st.followUpSec <= 0) goDormant()
    else listen(st.followUpSec * 1000)
  }

  /**
   * Did the current conversation start from the room (wake word, always-on
   * mic) rather than Space or the ask box? Set on every wake, so pressing
   * Space clears it. Follow-ups in the same conversation are from the room
   * too; the room context itself is used once, by the first request.
   */
  const roomTurn = useRef<Heard | null>(null)
  /** This request's room marking: the context goes with the first request only. */
  const takeRoom = (): Heard | null => {
    const r = roomTurn.current
    if (!r) return null
    roomTurn.current = { fromRoom: true, context: [] }
    return r
  }

  const respond = async (said: string, heard?: Heard | null): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    /**
     * Say an answer that needed no agent: the instant ones below and the fast
     * lane's. Both arrive whole, so there is nothing to stream — one turn in
     * the transcript, one line to the speaker, then the usual follow-up window.
     */
    const sayWhole = async (answer: string) => {
      s.setPhase('speaking')
      s.pushTurn({ id: newId(), role: 'jarvis', text: answer })
      spk.push(answer)
      try {
        await spk.end()
      } finally {
        if (!stale()) {
          speaker.current = null
          sfx.duck(false)
          music.duck(false)
          followUp()
        }
      }
    }

    // Maths, the time, the date, unit conversions: answered here in a few
    // milliseconds instead of a round trip to the model (see lib/instant.ts).
    const quick = instantAnswer(said)
    if (quick) {
      // Remembered for the fast lane's follow-ups, but not passed on to the
      // agent: it has no use for "it's ten past four".
      recordExchange(said, quick, { agentSaw: true })
      await sayWhole(quick)
      return
    }

    s.setPhase('thinking')

    // The fast lane (bridge/fastlane.mjs): small talk, general knowledge and
    // today's schedule or weather, in about a second instead of the agent's
    // four or more. It answers or hands off; a handoff, an error or a slow
    // bridge all simply fall through to the agent below, as before. Only with
    // the bridge — the direct-to-API path has no /fast to ask.
    if (usingBridge && currentSettings().fastLane) {
      const fast = await askFast(said, heard?.context ?? [])
      if (stale()) return
      if (fast) {
        recordExchange(said, fast, { agentSaw: false })
        await sayWhole(fast)
        return
      }
    }

    const turnId = newId()
    let started = false

    try {
      // To the agent with what it should know about the words: heard by the
      // always-on mic (so maybe not him), the room just before, and any fast
      // answers it missed. Shown in the transcript as he said it.
      const { text } = await ask(usingBridge ? forAgent(said, heard) : said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onStatus: (text) => {
          if (!stale()) store.getState().setActiveTool(text)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // No spoken filler ("One moment, sir"): the activity badge says what
          // he is doing, and he speaks only to answer.
        },
      })

      if (stale()) return

      // What he heard, for the fast lane's next follow-up ("and tomorrow?").
      if (text) recordExchange(said, text, { agentSaw: true })

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        followUp()
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string, heard?: Heard) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    roomTurn.current = heard ?? null

    store.getState().setError(null)
    sfx.play('wake')
    // Woken by voice while the desktop window is hidden: ask desktop/main.cjs
    // to bring it forward. The console is its only channel into the page (no
    // preload), the same way Esc asks to hide; in a browser this is a no-op.
    if (document.hidden) console.info('[zen:wake]')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing, takeRoom())
      return
    }

    store.getState().setPhase('waking')

    // No spoken "At your service": it talked over the command that usually
    // follows straight away. The reactor and status show he is listening; he
    // speaks only to answer.
    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said, takeRoom())
  }

  /**
   * Typed questions, from the ask box. No wake word and no microphone needed,
   * which also makes this the way in on browsers that block speech
   * recognition (Brave). Waits only for the power-up to finish.
   */
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = String((e as CustomEvent<string>).detail ?? '').trim()
      const phase = store.getState().phase
      if (!text || phase === 'offline' || phase === 'boot') return
      speaker.current?.cancel()
      // Typed: certainly him, and no longer the room's conversation.
      roomTurn.current = null
      void respond(text)
    }
    // STOP button and Esc: abandon the answer, silence him, back to rest.
    const onStop = () => {
      const phase = store.getState().phase
      if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
        turn.current++
        interrupt()
        store.getState().setActiveTool(null)
        music.working(false)
        sfx.duck(false)
        music.duck(false)
      }
      silence()
      speaker.current?.cancel()
      if (phase !== 'offline' && phase !== 'boot') goDormant()
    }
    // Esc: stop him if he is doing anything; if he is already at rest, put
    // ZEN away (the desktop app hides its window on this console line).
    // Never while typing — the terminal's own programs need Esc.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const st = store.getState()
      if (st.approval) return
      if (st.phase === 'dormant' || st.phase === 'offline') {
        console.info('[zen:hide]')
        return
      }
      onStop()
    }
    window.addEventListener('string:stop', onStop)
    window.addEventListener('keydown', onEsc)
    const onBrief = () => {
      const phase = store.getState().phase
      if (phase === 'offline' || phase === 'boot') return
      void respond(BRIEFING_PROMPT)
    }
    window.addEventListener('string:ask', onAsk)
    window.addEventListener('string:brief', onBrief)
    return () => {
      window.removeEventListener('string:ask', onAsk)
      window.removeEventListener('string:brief', onBrief)
      window.removeEventListener('string:stop', onStop)
      window.removeEventListener('keydown', onEsc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    // Not awaited: without a click yet, browsers leave resume() pending until
    // the first gesture, and awaiting it held the whole power-up at the
    // INITIALISE screen. Sound simply starts on the first click or key.
    void sfx.unlockAudio()
    // No background score: it competed with the user's own music and with
    // the microphone. (music.enable() would bring it back.)

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))
    // Before ZEN types or clicks anywhere: one card, Allow or Deny. A
    // previous answer never carries over to a new action, except inside an
    // explicit "Allow next 2 min" window — and never for a `fresh` card
    // (messages leaving the Mac), which is always shown and always asked.
    watchApprove(
      (text, fresh, withdrawn) =>
        new Promise<boolean>((resolve) => {
          const st = store.getState()
          if (!fresh && Date.now() < st.allowUntil) return resolve(true)
          st.approval?.resolve(false)
          sfx.play('tool')
          const card = {
            text,
            resolve: (ok: boolean) => {
              if (store.getState().approval === card) store.getState().setApproval(null)
              resolve(ok)
            },
          }
          st.setApproval(card)
          // Answered in ZEN Notch (or expired): take this copy off the screen.
          // bridge.ts drops the answer this produces; the notch's already counted.
          withdrawn.addEventListener('abort', () => card.resolve(false), { once: true })
        }),
    )
    // Proactive alerts: spoken only while nothing else is going on, so an
    // alert never talks over an answer. A missed one stays in the transcript.
    watchNotify((text) => {
      store.getState().pushTurn({ id: newId(), role: 'jarvis', text })
      // The agent never saw this line, so a bare "yes" to "Shall I compare
      // cabs?" would reach it with nothing to agree to. Passed on with the
      // next request, like a fast-lane answer.
      recordExchange('(nothing — ZEN spoke up on its own)', text, { agentSaw: false })
      // Hidden window: count it in the title, which the desktop app turns
      // into a Dock badge. Cleared when the window is looked at again.
      if (document.hidden) {
        unseen.current++
        document.title = `(${unseen.current}) Z.E.N.`
      }
      // Said aloud once he is free — never over an answer, never dropped.
      let tries = 0
      const sayWhenIdle = () => {
        const phase = store.getState().phase
        if (phase !== 'dormant' && phase !== 'listening') {
          if (++tries < 120) setTimeout(sayWhenIdle, 1000)
          return
        }
        sfx.play('wake')
        const spk = createSpeaker()
        spk.push(text)
        void spk.end()
      }
      sayWhenIdle()
    })

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'terminal':
          if (a.run) s.openTerminalWith(String(a.run))
          else s.setTerminalOpen(a.open ?? true)
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
    // No automatic morning briefing: ZEN speaks only when asked. BRIEF in the
    // toolbar gives one on demand.
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  /**
   * Power up on load: no INITIALISE click, no boot sequence.
   *
   * Browsers hold sound until the page has had a click or a key press, so the
   * first one anywhere unlocks it — including the speech engine, which Safari
   * only lets speak after an utterance made inside a gesture. The INITIALISE
   * button stays as the fallback if this power-up fails.
   */
  useEffect(() => {
    void powerOn()
    const unlock = () => {
      void sfx.unlockAudio()
      try {
        window.speechSynthesis?.speak(new SpeechSynthesisUtterance(''))
      } catch {
        /* no speech engine — the bridge voice covers it */
      }
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  /**
   * The mic level drives only the visuals (the orb, the meter): the voice loop
   * measures its own. So it pumps only while the window is open — hidden, a
   * frame loop here would keep the renderer busy sixty times a second for
   * nobody, since backgroundThrottling is off in the desktop app.
   */
  useEffect(() => {
    if (!windowOpen) {
      store.getState().setLevel(0)
      return
    }
    let raf = 0
    const pump = () => {
      const st = store.getState()
      // While speaking, follow ZEN's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise. Push-to-talk at rest:
      // the mic means nothing until Space, so the orb and meter stay still.
      const atRest = st.phase === 'dormant' && !currentSettings().wakeWord
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : atRest
            ? 0
            : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
        // Push-to-talk: a shorter wait for the first word, so a press with
        // nothing said does not leave the mic open to the room for long.
        if (!currentSettings().wakeWord) listen(PTT_AWAIT_MS)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {/* Hidden, the scene is unmounted, not paused: unmounting the R3F
          Canvas disposes the renderer and loses its WebGL context, which is
          what actually lets the GPU process go quiet. It is rebuilt on show. */}
      {windowOpen && <Scene />}
      <Hud />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
