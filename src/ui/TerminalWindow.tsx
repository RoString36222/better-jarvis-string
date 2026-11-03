import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { BRIDGE_WS_URL } from '../config'

/**
 * ZEN's terminal: a real shell in a window on the left half of the screen,
 * so it can sit beside the player and the reactor. "Open terminal" or "open
 * kitty" by voice, or the TERMINAL button. Closing the window ends the shell.
 */

const THEME = {
  background: '#00000000',
  foreground: '#dfe9ff',
  cursor: '#6a9bff',
  cursorAccent: '#020612',
  selectionBackground: '#2f6bff55',
  black: '#0b1530', red: '#ff6b81', green: '#5ef2b5', yellow: '#ffd479',
  blue: '#6a9bff', magenta: '#b48cff', cyan: '#5fd7ff', white: '#dfe9ff',
  brightBlack: '#4a5a80', brightRed: '#ff8fa0', brightGreen: '#8af7cb', brightYellow: '#ffe2a3',
  brightBlue: '#9cbcff', brightMagenta: '#cdb2ff', brightCyan: '#94e6ff', brightWhite: '#ffffff',
}

function Shell({ onEnded, run }: { onEnded: () => void; run?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      theme: THEME,
      allowTransparency: true,
      fontFamily: "'JetBrains Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)

    let retry = 0
    const ws = new WebSocket(`${BRIDGE_WS_URL.replace(/\/$/, '')}/term${run ? `?run=${encodeURIComponent(run)}` : ''}`)
    const sendSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => {
      setState('open')
      sendSize()
      term.focus()
    }
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
    ws.onclose = () => {
      setState('closed')
      term.write('\r\n\x1b[2m[shell ended — reconnecting… (↻ for a new one, ✕ to close)]\x1b[0m\r\n')
      // The bridge restarting ends the shell; come back with a fresh one.
      retry = window.setTimeout(() => onEnded(), 2500)
    }
    const input = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
    })
    const ro = new ResizeObserver(() => sendSize())
    ro.observe(host.current)

    return () => {
      clearTimeout(retry)
      ro.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [])

  return (
    <>
      {state === 'connecting' && <div className="tw-note">connecting…</div>}
      <div className="tw-term" ref={host} />
    </>
  )
}

export function TerminalWindow() {
  const open = useStore((s) => s.terminalOpen)
  const setOpen = useStore((s) => s.setTerminalOpen)
  const terminalRun = useStore((s) => s.terminalRun)
  /** Bumped to start a fresh shell after the old one exited. */
  const [session, setSession] = useState(0)
  /** Only the session ZEN opened starts the program; ↻ gives a plain shell. */
  const [runSession, setRunSession] = useState(-1)
  useEffect(() => {
    if (terminalRun) setRunSession(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalRun])
  const runFor = (n: number) => (terminalRun && n === runSession ? terminalRun.run : undefined)
  const [wide, setWide] = useState(false)
  /** Dragged size, remembered across sessions; null = the default half screen. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('zen.term.size') || 'null')
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('zen.term.size', JSON.stringify(size))
    } catch {
      /* storage blocked */
    }
  }, [size])
  const box = useRef<HTMLElement>(null)
  const onGrip = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    e.preventDefault()
    const from = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) =>
      setSize({
        w: Math.max(360, Math.min(window.innerWidth - 100, from.w + ev.clientX - from.x)),
        h: Math.max(220, Math.min(window.innerHeight - 140, from.h + ev.clientY - from.y)),
      })
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          ref={box}
          className={`tw${wide ? ' tw-wide' : ''}`}
          style={size && !wide ? { width: size.w, height: size.h, bottom: 'auto' } : undefined}
          initial={{ opacity: 0, x: -24, filter: 'blur(6px)' }}
          animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: -24, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        >
          <span className="pk pk-tl" />
          <span className="pk pk-tr" />
          <span className="pk pk-bl" />
          <span className="pk pk-br" />
          <header className="tw-head">
            <span className="tw-title">
              <span className="tw-dot" /> TERMINAL · {(navigator.platform || 'mac').toLowerCase().includes('mac') ? 'zsh' : 'shell'}
            </span>
            <span className="tw-acts">
              <button className="bl-btn" onClick={() => setSession((n) => n + 1)} title="New shell">
                ↻
              </button>
              {size && (
                <button className="bl-btn" onClick={() => setSize(null)} title="Back to half screen">
                  ⤾
                </button>
              )}
              <button className="bl-btn" onClick={() => setWide((v) => !v)} title={wide ? 'Half screen' : 'Wider'}>
                {wide ? '⤡' : '⤢'}
              </button>
              <button className="bl-btn" onClick={() => setOpen(false)} title="Close (ends the shell)">
                ✕
              </button>
            </span>
          </header>
          <div className="tw-body">
            <Shell key={`${session}|${terminalRun?.at ?? 0}`} run={runFor(session)} onEnded={() => setSession((n) => n + 1)} />
          </div>
          <span className="bl-grip tw-grip" onPointerDown={onGrip} title="Drag to resize" />
        </motion.section>
      )}
    </AnimatePresence>
  )
}
