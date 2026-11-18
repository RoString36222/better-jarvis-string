/**
 * ZEN on the desktop: one window, summoned from anywhere with a hotkey.
 *
 * The window is the same page the browser shows (http://localhost:5174). If
 * ZEN is not already running, this starts it with ../start-kimi.sh and stops
 * it again on quit; if it is, the window simply attaches.
 *
 * Hearing goes through local Whisper, so Electron's lack of the browser speech
 * API does not matter here.
 *
 *   ZEN_HOTKEY   global shortcut, default Alt+Space (⌥Space)
 *   ZEN_URL      page to load, default http://localhost:5174
 */
const { app, BrowserWindow, globalShortcut, session, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')

const URL = process.env.ZEN_URL || 'http://localhost:5174'
const HOTKEY = process.env.ZEN_HOTKEY || 'Alt+Space'
const ROOT = path.resolve(__dirname, '..')

let win = null
let server = null

/**
 * Is the page being served? Asked over HTTP by its own URL, not by probing a
 * port: Vite binds "localhost" to ::1 only on macOS, so a 127.0.0.1 probe says
 * no while the page is up — and this would start a second ZEN.
 */
const pageUp = () =>
  fetch(URL, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false)

async function ensureServer() {
  if (await pageUp()) return
  // Opened from Finder or Launchpad, an app gets a bare PATH with no Homebrew,
  // so node, npm and whisper-server would all be missing.
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` }
  server = spawn(path.join(ROOT, 'start-kimi.sh'), [], { cwd: ROOT, env, stdio: 'ignore', detached: true })
  for (let i = 0; i < 120 && !(await pageUp()); i++) await new Promise((r) => setTimeout(r, 500))
}

/** Hides ZEN, leaving full screen first so no empty space is left behind. */
function hideWin() {
  if (!win || !win.isVisible()) return
  if (win.isFullScreen()) {
    win.once('leave-full-screen', () => win?.hide())
    win.setFullScreen(false)
  } else win.hide()
}

/**
 * Tell the page whether it is on screen. With backgroundThrottling off the
 * page's own Page Visibility API always says "visible", so without this a
 * hidden ZEN kept its whole 3D scene rendering on the GPU for nobody. The page
 * (src/lib/windowState.ts) unmounts the scene and stops its loops on false.
 */
function tellPage(open) {
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent('zen:window', { detail: { open: ${open ? 'true' : 'false'} } })); true`)
    .catch(() => {})
}
const onScreen = () => Boolean(win && win.isVisible() && !win.isMinimized())

/** Brings ZEN forward from anywhere — including ZEN Notch's "Open ZEN". */
function showWin() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  // Clicked from the notch, another app is frontmost; a plain focus() would
  // only bounce the Dock icon.
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

/** The window, created once and kept: hiding it keeps ⌥Space working. */
let opening = null
function openWindow() {
  if (win) return Promise.resolve(win)
  if (opening) return opening
  opening = (async () => {
    await ensureServer()
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      title: 'ZEN',
      backgroundColor: '#020612',
      titleBarStyle: 'hiddenInset',
      show: false,
      // A desktop app has no reason to wait for a click before it can speak.
      // backgroundThrottling off: hidden, Chromium would slow its timers and
      // audio callbacks, and the wake word would stop being heard while ZEN
      // sits in the background — exactly when it is meant to be listening.
      webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    })
    // The page counts alerts that arrived while hidden in its title, "(2) Z.E.N.";
    // mirror that onto the Dock icon as a badge.
    win.on('page-title-updated', (e, title) => {
      const n = title.match(/^\((\d+)\)/)?.[1] ?? ''
      if (process.platform === 'darwin') app.dock.setBadge(n)
    })
    for (const ev of ['show', 'restore']) win.on(ev, () => tellPage(true))
    for (const ev of ['hide', 'minimize']) win.on(ev, () => tellPage(false))
    // A reload starts the page believing it is open; correct it if it is not.
    win.webContents.on('did-finish-load', () => tellPage(onScreen()))
    win.on('focus', () => {
      if (process.platform === 'darwin') app.dock.setBadge('')
    })
    // ✕ hides rather than quits, so ⌥Space can always bring ZEN back. ⌘Q quits.
    win.on('close', (e) => {
      if (app.isQuitting) return
      e.preventDefault()
      hideWin()
    })
    win.on('closed', () => {
      win = null
      opening = null
    })
    // Esc in the page, when ZEN has nothing to stop, asks to be put away. The
    // page decides (it knows whether it is busy or a terminal has focus) and
    // says so on the console — there is no other channel without a preload.
    win.webContents.on('console-message', (e, level, message) => {
      const text = typeof e?.message === 'string' ? e.message : message
      if (text === '[zen:hide]') hideWin()
      // Woken by voice while hidden ("Hey Zen" from across the room): come
      // forward so the answer and its panels are on screen. Listening itself
      // kept working while hidden because backgroundThrottling is off above.
      // No Space keypress here, unlike summon(): the page is already listening.
      if (text === '[zen:wake]' && win && !win.isVisible()) {
        win.show()
        win.focus()
      }
      // ZEN Notch's "Open ZEN": the bridge relays it to the page, the page here.
      if (text === '[zen:show]') showWin()
    })
    await win.loadURL(URL)
    // Asked after the window is up: the macOS prompt waits for the user.
    if (process.platform === 'darwin') void systemPreferences.askForMediaAccess('microphone').catch(() => {})
    return win
  })()
  return opening
}

async function summon() {
  const w = await openWindow()
  if (w.isVisible() && w.isFocused()) return hideWin()
  w.show()
  w.focus()
  // Same as pressing Space in the page: start listening, no wake word needed.
  w.webContents
    .executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' })); true")
    .catch(() => {})
}

app.whenReady().then(async () => {
  // The page asks for the microphone (and the camera when told to look).
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) =>
    done(['media', 'microphone', 'camera', 'audioCapture', 'videoCapture'].includes(permission)),
  )
  if (!globalShortcut.register(HOTKEY, () => void summon())) {
    console.warn(`[zen] ${HOTKEY} is taken by another app — set ZEN_HOTKEY to something else`)
  }
  const w = await openWindow()
  w.show()
})

app.on('activate', () => void openWindow().then((w) => w.show()))
app.on('before-quit', () => {
  app.isQuitting = true
  // Only stop what this app started; an already-running ZEN is left alone.
  if (server) {
    try {
      process.kill(-server.pid)
    } catch {
      /* already gone */
    }
  }
})
app.on('will-quit', () => globalShortcut.unregisterAll())
