import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Blade } from '../store'

/**
 * The strip of controls along the top right: HISTORY, TIDY, CLEAR VIEW, CAMERA.
 *
 * Everything here is something the user would otherwise have to say out loud,
 * and saying "close everything" to a room is slower than one click. None of it
 * talks to the model — these act on the screen directly.
 */
export function Toolbar() {
  const blades = useStore((s) => s.blades)
  const history = useStore((s) => s.bladeHistory)
  const layout = useStore((s) => s.bladeLayout)
  const setLayout = useStore((s) => s.setBladeLayout)
  const closeAll = useStore((s) => s.closeAllBlades)
  const pushBlade = useStore((s) => s.pushBlade)
  const [open, setOpen] = useState(false)

  const tiled = layout === 'wall' || (layout === 'auto' && blades.length >= 3)
  const cameraOpen = blades.some((b) => b.kind === 'camera')

  const reopen = (b: Blade) => {
    // Reopened sticky: something pulled back on purpose should not vanish the
    // next time the user speaks.
    pushBlade({ ...b, hold: 'sticky' })
    setOpen(false)
  }

  const toggleCamera = () => {
    const cam = blades.find((b) => b.kind === 'camera')
    if (cam) {
      useStore.getState().closeBlade(cam.id)
      return
    }
    pushBlade({
      id: `cam-${Date.now().toString(36)}`,
      title: 'CAMERA',
      kind: 'camera',
      size: 'compact',
      hold: 'sticky',
    })
  }

  return (
    <div className="toolbar">
      <button
        className={`tb-btn${open ? ' tb-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={!history.length}
        title="Everything opened this session"
      >
        HISTORY{history.length ? ` ${history.length}` : ''}
      </button>
      <button
        className={`tb-btn${tiled ? ' tb-on' : ''}`}
        onClick={() => setLayout(tiled ? 'stack' : 'wall')}
        disabled={!blades.length}
        title={tiled ? 'Stack the panels' : 'Tile every panel'}
      >
        TIDY
      </button>
      <button
        className="tb-btn"
        onClick={() => {
          closeAll()
          setOpen(false)
        }}
        disabled={!blades.length}
        title="Close every panel"
      >
        CLEAR VIEW
      </button>
      <button
        className="tb-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('string:brief'))}
        title="Weather, your day, and anything firing"
      >
        BRIEF
      </button>
      <button className={`tb-btn${cameraOpen ? ' tb-on' : ''}`} onClick={toggleCamera} title="Camera">
        CAMERA
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            className="tb-history"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            {[...history].reverse().map((b) => (
              <li key={b.id}>
                <button onClick={() => reopen(b)}>
                  <span className="tbh-title">{b.title}</span>
                  <span className="tbh-kind">{b.kind}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Type a question instead of saying it. Enter sends; Escape clears and leaves
 * the box so the keyboard shortcuts work again.
 */
export function AskBox() {
  const phase = useStore((s) => s.phase)
  const [text, setText] = useState('')
  const ready = phase !== 'offline' && phase !== 'boot'
  const send = () => {
    const q = text.trim()
    if (!q || !ready) return
    window.dispatchEvent(new CustomEvent('string:ask', { detail: q }))
    setText('')
  }
  return (
    <form
      className="askbox"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <input
        className="askbox-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('')
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        placeholder={ready ? 'Type to ask ZEN…' : 'Click INITIALISE first'}
        disabled={!ready}
        aria-label="Ask ZEN"
      />
      <button className="tb-btn" type="submit" disabled={!ready || !text.trim()}>
        ASK
      </button>
    </form>
  )
}
