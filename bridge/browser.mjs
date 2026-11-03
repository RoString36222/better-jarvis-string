import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'

/**
 * Hands in Safari: read the page in front of the user, then type, tick and
 * click on it — the way a person would, through the page itself.
 *
 * Every action that changes anything is put to the user first as an Allow /
 * Deny card in ZEN (`ask('approve', …)`), one action at a time, and some are
 * never taken at all: agreeing to terms, paying, deleting, and password
 * fields stay with the user however the request is phrased.
 *
 * Needs Safari → Develop → "Allow JavaScript from Apple Events".
 */

const osa = (script, args = []) =>
  new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script, ...args], { timeout: 15_000 }, (err, out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(out).trim()),
    ),
  )

/** Runs JS in Safari's current tab; the script is passed as an argument, never spliced. */
const inPage = (js) =>
  osa('on run argv\ntell application "Safari" to do JavaScript (item 1 of argv) in current tab of front window\nend run', [js])

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Never done for the user, only described to them. */
const OFF_LIMITS =
  /\b(agree|terms|accept|consent|pay|payment|purchase|buy|checkout|order|subscribe|delete|remove|password|transfer|send money|sign up for)\b/i

/**
 * Lists the controls on the page with stable ids (data-zen-id), labels,
 * types and current values — the model's "view" of the form.
 */
const SCAN = `(() => {
  const label = (el) => {
    const byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    const wrap = el.closest('label')
    const aria = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText)
    let t = aria || (byFor && byFor.innerText) || (wrap && wrap.innerText) || el.placeholder || el.name || el.innerText || el.value || ''
    if (!t) { const box = el.closest('div'); const h = box && box.querySelector('label, h1, h2, h3, h4, p, span'); t = h ? h.innerText : '' }
    return String(t).replace(/\\s+/g, ' ').trim().slice(0, 80)
  }
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  let n = 0
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select, button, [role=button], a[href], [role=checkbox]')) {
    if (!vis(el) || el.type === 'hidden') continue
    if (!el.dataset.zenId) el.dataset.zenId = 'z' + (++n) + Math.random().toString(36).slice(2, 5)
    const tag = el.tagName.toLowerCase()
    out.push({
      id: el.dataset.zenId,
      kind: tag === 'a' ? 'link' : tag === 'button' || el.getAttribute('role') === 'button' ? 'button' : el.type === 'checkbox' || el.getAttribute('role') === 'checkbox' ? 'checkbox' : tag === 'select' ? 'select' : el.type === 'password' ? 'password' : 'text',
      label: label(el),
      value: el.type === 'checkbox' ? String(el.checked) : el.type === 'password' ? '' : String(el.value ?? '').slice(0, 60),
      required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
    })
    if (out.length >= 80) break
  }
  return JSON.stringify({ url: location.href, title: document.title, controls: out })
})()`

/** Types into an input the way a React form notices: native setter + events. */
const fillJs = (id, text) => `(() => {
  const el = document.querySelector('[data-zen-id="${id}"]')
  if (!el) return 'gone'
  el.focus()
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`

const clickJs = (id) => `(() => {
  const el = document.querySelector('[data-zen-id="${id}"]')
  if (!el) return 'gone'
  el.scrollIntoView({ block: 'center' })
  el.click()
  return 'ok'
})()`

const describe = (id) =>
  inPage(`(() => { const el = document.querySelector('[data-zen-id="${id}"]'); if (!el) return ''; return JSON.stringify({ label: (el.closest('label')?.innerText || el.getAttribute('aria-label') || el.placeholder || el.innerText || el.name || '').replace(/\\s+/g,' ').trim().slice(0,80), type: el.type || el.tagName.toLowerCase() }) })()`)
    .then((s) => (s ? JSON.parse(s) : null))
    .catch(() => null)

const safariError = (err) =>
  /Allow JavaScript from Apple Events/i.test(err.message)
    ? fail('Safari is blocking this: the user must turn on Safari → Develop → "Allow JavaScript from Apple Events" (Develop appears after Settings → Advanced → "Show features for web developers"). Tell them that.')
    : fail(`Safari: ${err.message}`)

/**
 * Puts Safari on the right half of the screen, in front, so the user watches
 * ZEN work — ZEN itself (and its Allow cards) on the left. Done once per task,
 * not on every call, so it does not fight the user moving windows.
 */
let shownAt = 0
async function showSafari() {
  if (Date.now() - shownAt < 90_000) return
  shownAt = Date.now()
  try {
    const [, , w, h] = (await osa('tell application "Finder" to get bounds of window of desktop')).split(/,\s*/).map(Number)
    await osa(
      `tell application "Safari"\nactivate\nset bounds of front window to {${Math.round(w / 2)}, 25, ${w}, ${h}}\nend tell`,
    )
  } catch {
    /* tiling is a nicety; the task does not depend on it */
  }
}

export function browserServer(ask) {
  const approve = async (text) => {
    try {
      const r = await ask('approve', { text }, 120_000)
      return r?.ok === true
    } catch {
      return false
    }
  }

  return createSdkMcpServer({
    name: 'jarvis_hands',
    version: '1.0.0',
    tools: [
      tool(
        'safari_page',
        "Read the page open in the user's Safari: its URL, title and every form control with an id, " +
          'label, kind and current value. Always call this first, and again after the page changes.',
        {},
        async () => {
          try {
            await showSafari()
            return ok(await inPage(SCAN))
          } catch (err) {
            return safariError(err)
          }
        },
      ),
      tool(
        'safari_type',
        'Type text into a text field on the Safari page, by its id from safari_page. The user approves each one.',
        { id: z.string(), text: z.string() },
        async ({ id, text }) => {
          try {
            const el = await describe(id)
            if (!el) return fail('That control is no longer on the page; call safari_page again.')
            if (el.type === 'password') return fail('Password fields are the user\'s to fill. Ask them to type it.')
            if (!(await approve(`Type “${text}” into “${el.label || 'the field'}”`))) return fail('The user said no.')
            return (await inPage(fillJs(id, text))) === 'ok' ? ok('Typed.') : fail('That control is gone.')
          } catch (err) {
            return safariError(err)
          }
        },
      ),
      tool(
        'safari_click',
        'Click a button, checkbox or link on the Safari page, by its id from safari_page. The user approves each one. ' +
          'Agreeing to terms, paying, ordering, deleting and similar are refused — leave those to the user and say so.',
        { id: z.string() },
        async ({ id }) => {
          try {
            const el = await describe(id)
            if (!el) return fail('That control is no longer on the page; call safari_page again.')
            if (OFF_LIMITS.test(el.label)) {
              return fail(`“${el.label}” is for the user to click themselves (terms, payments and deletions are never done for them). Tell them it is the remaining step.`)
            }
            if (!(await approve(`Click “${el.label || 'this'}”`))) return fail('The user said no.')
            return (await inPage(clickJs(id))) === 'ok' ? ok('Clicked.') : fail('That control is gone.')
          } catch (err) {
            return safariError(err)
          }
        },
      ),
      tool(
        'safari_open',
        'Open a URL in the current Safari tab. The user approves it.',
        { url: z.string() },
        async ({ url }) => {
          if (!/^https:\/\//i.test(url)) return fail('Only https addresses.')
          if (!(await approve(`Open ${url} in Safari`))) return fail('The user said no.')
          await osa('on run argv\ntell application "Safari" to set URL of current tab of front window to (item 1 of argv)\nend run', [url])
          return ok('Opened. Call safari_page once it has loaded.')
        },
      ),
    ],
  })
}
