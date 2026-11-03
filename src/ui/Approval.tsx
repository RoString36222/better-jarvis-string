import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * "ZEN wants to: Type 'ZEN' into App name" — Allow / Deny. Shown for every
 * action ZEN takes on the user's behalf in another app; nothing is typed or
 * clicked until this is answered.
 */
export function Approval() {
  const approval = useStore((s) => s.approval)
  const setAllowUntil = useStore((s) => s.setAllowUntil)
  return (
    <AnimatePresence>
      {approval && (
        <motion.div
          className="ap"
          role="alertdialog"
          aria-label="ZEN wants to act"
          initial={{ opacity: 0, y: -14, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: -14, x: '-50%' }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        >
          <span className="pk pk-tl" />
          <span className="pk pk-tr" />
          <span className="pk pk-bl" />
          <span className="pk pk-br" />
          <div className="ap-kicker">ZEN WANTS TO</div>
          <div className="ap-text">{approval.text}</div>
          <div className="ap-acts">
            <button className="tb-btn ap-deny" onClick={() => approval.resolve(false)}>
              DENY
            </button>
            <button
              className="tb-btn"
              onClick={() => {
                setAllowUntil(Date.now() + 2 * 60_000)
                approval.resolve(true)
              }}
              title="Allow this and every action for the next two minutes"
            >
              ALLOW NEXT 2 MIN
            </button>
            <button className="tb-btn tb-on" onClick={() => approval.resolve(true)} autoFocus>
              ALLOW
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
