import { useSyncExternalStore } from 'react'

/**
 * Is ZEN's window on screen?
 *
 * Hidden, ZEN should cost almost nothing: the 3D scene is unmounted (its WebGL
 * context released), the camera is let go, and the endless animation loops
 * stop. Only the voice loop and the bridge socket keep running, so "Hey Zen"
 * still works and ZEN Notch carries the face meanwhile.
 *
 * The browser's own signal cannot be trusted for this in the desktop app: it
 * runs with backgroundThrottling off (so listening keeps working hidden), and
 * that also pins the Page Visibility API at "visible" — a hidden window looks
 * open forever. So desktop/main.cjs tells the page itself, with a
 * `zen:window` event on every show and hide. In a plain browser tab, which
 * never gets that event, `document.hidden` is the signal and works fine.
 */

let electronOpen = true
let open = computeOpen()
const listeners = new Set<() => void>()

function computeOpen() {
  return electronOpen && !document.hidden
}

function update() {
  const next = computeOpen()
  if (next === open) return
  open = next
  // A class on <html> lets CSS pause every keyframe animation in one rule
  // (index.css), rather than every component learning about this.
  document.documentElement.classList.toggle('zen-hidden', !open)
  listeners.forEach((fn) => fn())
}

window.addEventListener('zen:window', (e) => {
  electronOpen = (e as CustomEvent<{ open?: boolean }>).detail?.open !== false
  update()
})
document.addEventListener('visibilitychange', update)

export const isWindowOpen = () => open

export function onWindowChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-renders on show/hide. Components that only exist to be looked at gate on it. */
export function useWindowOpen(): boolean {
  return useSyncExternalStore(onWindowChange, isWindowOpen)
}

/**
 * Ask the desktop app to bring the window forward (ZEN Notch's "Open ZEN").
 * The console is the page's only line to Electron — there is no preload — and
 * main.cjs already listens there for '[zen:hide]' and '[zen:wake]'.
 */
export function requestShow() {
  console.info('[zen:show]')
}
