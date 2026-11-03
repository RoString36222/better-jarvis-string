import { useEffect, useRef, useState } from 'react'
import { useStore, accentFor, type Phase } from '../store'

/**
 * The centre: a HUD reactor of concentric arcs, drawn crisp in SVG.
 *
 * It replaced the bloomed shader disc, whose soft, dusty edge could never be
 * made sharp — bloom and thin lines are opposites. Here every ring is its own
 * layer, so the state can be told by geometry rather than by glow:
 *
 *   dormant    collapsed: the rings draw in toward the main band, dim
 *   listening  expanded: the rings spread apart, ready
 *   thinking   spindle: the rings turn edge-on and thread out along one axis
 *   speaking   flat and open, the main band breathing with the voice
 *
 * Rotation is accumulated per frame (not CSS keyframes) so a change of pace
 * never makes a ring jump; the tilt and spread are registered CSS properties
 * (see index.css) so moving between states is a smooth transition.
 */

type Layer = {
  id: string
  /** Degrees per second at rest; sign is direction. */
  speed: number
  /** Gyroscope tilt (the 'gyro' mode, kept for "spin like a gyroscope"). */
  tilt: [number, number]
  /** Spindle mode: how far along the shared axis this ring slides, in px of
   *  the 580px reactor. Rings thread out on either side of the main band. */
  along: number
}

const LAYERS: Layer[] = [
  { id: 'ticks', speed: 4, tilt: [62, 18], along: 250 },
  { id: 'dots', speed: -7, tilt: [-48, 52], along: 175 },
  { id: 'segments', speed: 11, tilt: [24, -66], along: -150 },
  { id: 'band', speed: 0, tilt: [0, 0], along: 0 },
  { id: 'inner', speed: -16, tilt: [70, -12], along: 70 },
  { id: 'cross', speed: 0, tilt: [0, 0], along: -230 },
]

/** How hard each phase drives the spin. */
const PACE: Record<Phase, number> = {
  offline: 0.2,
  boot: 1,
  dormant: 0.35,
  waking: 1.4,
  listening: 1,
  thinking: 3.2,
  tooling: 3.6,
  speaking: 1.2,
}

const MODE: Record<Phase, string> = {
  // At rest it is the spindle too, only dimmer and slower — "Hey Zen" swings
  // the rings round to face you, and thinking threads them out again.
  offline: 'spindle arc-idle',
  boot: 'spindle arc-idle',
  dormant: 'spindle arc-idle',
  waking: 'expanded',
  listening: 'expanded',
  thinking: 'spindle',
  tooling: 'spindle',
  speaking: 'open',
}

const ticks = Array.from({ length: 120 }, (_, i) => i)

/**
 * Once the thinking spindle is up it stays at least this long. A fast answer
 * would otherwise flash it for a frame and swing straight back, which reads as
 * a glitch rather than as thought.
 */
const SPINDLE_HOLD_MS = 1500

/** The phase's look, with the thinking spindle held for SPINDLE_HOLD_MS. */
function useHeldMode(phase: Phase): string {
  const want = MODE[phase]
  const [shown, setShown] = useState(want)
  const since = useRef(performance.now())
  useEffect(() => {
    if (want === shown) return
    const thinking = shown === 'spindle'
    const wait = thinking ? SPINDLE_HOLD_MS - (performance.now() - since.current) : 0
    const t = setTimeout(() => {
      since.current = performance.now()
      setShown(want)
    }, Math.max(0, wait))
    return () => clearTimeout(t)
  }, [want, shown])
  return shown
}

export function ArcReactor() {
  const root = useRef<HTMLDivElement>(null)
  const phase = useStore((s) => s.phase)
  const ui = useStore((s) => s.ui)
  const blades = useStore((s) => s.blades.length + (s.terminalOpen ? 1 : 0))
  const mode = useHeldMode(phase)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lvl = 0
    const angle = LAYERS.map(() => Math.random() * 360)
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = useStore.getState()
      lvl += (s.level - lvl) * Math.min(1, dt * 10)
      const pace = PACE[s.phase] * s.ui.reactor.spin
      const el = root.current
      if (!el) return
      LAYERS.forEach((l, i) => {
        angle[i] = (angle[i] + l.speed * pace * dt) % 360
        el.style.setProperty(`--a-${l.id}`, `${angle[i].toFixed(2)}deg`)
      })
      el.style.setProperty('--lvl', lvl.toFixed(3))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (!ui.reactor.visible) return null
  const accent = ui.reactor.color ?? accentFor(phase, ui)

  return (
    <div
      ref={root}
      className={`arc arc-${mode}${blades ? ' arc-dim' : ''}`}
      style={{
        ['--arc-accent' as string]: accent,
        ['--arc-scale' as string]: ui.reactor.scale,
        ['--arc-glow' as string]: ui.reactor.intensity,
      }}
      aria-hidden
    >
      {/* The spindle's axis: the line the rings thread onto while thinking. */}
      <div className="arc-axis" />

      {/* Corner brackets, outside the rings, like a targeting frame. */}
      <svg className="arc-frame" viewBox="-250 -250 500 500">
        {[45, 135, 225, 315].map((d) => (
          <g key={d} transform={`rotate(${d})`}>
            <line x1="212" y1="-7" x2="226" y2="-7" />
            <line x1="212" y1="7" x2="226" y2="7" />
          </g>
        ))}
      </svg>

      {LAYERS.map((l) => (
        <div
          key={l.id}
          className={`arc-layer arc-${l.id}`}
          style={{
            ['--tx' as string]: `${l.tilt[0]}deg`,
            ['--ty' as string]: `${l.tilt[1]}deg`,
            ['--along' as string]: `calc(${l.along}px * var(--arc-k))`,
          }}
        >
          <svg viewBox="-250 -250 500 500">
            {l.id === 'ticks' &&
              ticks.map((i) => (
                <line
                  key={i}
                  className={i % 10 === 0 ? 'tk-long' : 'tk'}
                  x1="0"
                  y1={i % 10 === 0 ? -196 : -190}
                  x2="0"
                  y2="-182"
                  transform={`rotate(${i * 3})`}
                />
              ))}
            {l.id === 'dots' && (
              <>
                <circle r="170" className="ring-dots" />
                <circle r="176" className="ring-hair" />
              </>
            )}
            {l.id === 'segments' && (
              <>
                <circle r="152" className="ring-seg" pathLength="100" />
                <circle r="146" className="ring-seg-thin" pathLength="100" />
              </>
            )}
            {l.id === 'band' && (
              <>
                <circle r="124" className="ring-band" />
                <circle r="124" className="ring-band-core" />
                <circle r="108" className="ring-hair" />
              </>
            )}
            {l.id === 'inner' && (
              <>
                <circle r="92" className="ring-inner" pathLength="100" />
                <circle r="84" className="ring-inner-thin" pathLength="100" />
              </>
            )}
            {l.id === 'cross' && (
              <>
                {[0, 90, 180, 270].map((d) => (
                  <line key={d} className="cross" x1="0" y1="-30" x2="0" y2="-72" transform={`rotate(${d})`} />
                ))}
                <circle r="18" className="ring-core" />
                <circle r="4" className="core-dot" />
              </>
            )}
          </svg>
        </div>
      ))}
    </div>
  )
}
