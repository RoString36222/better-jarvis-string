import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usageTool } from './usage.mjs'

/**
 * The gate: every tool call ZEN's agent wants to make passes through here, and
 * this file — not the model, not the persona, not anything the model reads —
 * decides whether it runs.
 *
 * It used to be one boolean. Read-only things ran, everything else was refused
 * unless JARVIS_ALLOW_WRITES=1, because a voice assistant has no dialog to
 * click and the bridge had to be the one that was sure. That was right when
 * there was no way to ask. There is now: ZEN draws an approval card on screen
 * (`ask('approve', { text })`, the same card Safari hands use), so "can't ask,
 * so refuse" becomes "ask". What that leaves is three tiers:
 *
 *   deny  — never, approval or not. Wiping a disk, piping the internet into a
 *           shell, reading SSH keys, force-pushing main. One tired "yes" on a
 *           card must not be able to do these, and nothing the model reads in
 *           a web page can argue its way past a regex.
 *   ask   — the approval card. Everything that writes or acts when the user
 *           has not turned on ALLOW_WRITES, and — even when they have — the
 *           things that reach other people or other machines: pushing code,
 *           deploying, sending messages, installing software, recursive
 *           deletes, production systems. A timeout is a no.
 *   auto  — everything decideTool (the old policy, kept verbatim) already let
 *           through.
 *
 * Every decision, in every tier, goes to ~/.string/actions.jsonl so "what did
 * you do today?" has a real answer (see actionsServer below).
 *
 * The regexes are deliberately conservative: a false "ask" costs the user one
 * tap; a false "auto" on a destructive command costs whatever it destroyed.
 */

// ===================================================================== policy
//
// Everything from here to decideTool is moved verbatim from server.mjs — it is
// the "auto" tier. Its comments are kept because the reasoning still holds.

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1 — or,
 * now, for the user's Allow on the approval card (see makeGate).
 */
export const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
export const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
export const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
export const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
export const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/**
 * ZEN's own in-process servers. Each one either changes nothing outside ZEN or
 * gates itself with its own approval card, so the gate never adds a second
 * card on top — see the per-server notes in decideTool.
 */
const OWN_SERVERS = new Set([
  'jarvis', 'jarvis_ui', 'jarvis_chrome', 'jarvis_eyes', 'jarvis_search', 'jarvis_memory',
  'jarvis_mac', 'jarvis_hands', 'jarvis_term', 'jarvis_log', 'jarvis_context', 'jarvis_usage', 'jarvis_life',
])

export function decideTool(name, input) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them ZEN has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    // Search reads the web and changes nothing.
    if (server === 'jarvis_search') return true

    // Memory writes only to STRING's own file, and only what the user said.
    if (server === 'jarvis_memory') return true

    // The Mac tools are a fixed list of named actions (open an allowlisted
    // app, Spotify, volume, reminders) with no shell behind them — see mac.mjs.
    if (server === 'jarvis_mac') return true

    // Safari hands: reading is free, and every type/click/open waits for the
    // user's Allow in ZEN (browser.mjs) — that card is the gate, not this.
    if (server === 'jarvis_hands') return true

    // Messages into a Claude Code session ZEN started; each one approved by
    // the user, '!' (shell) refused — see claudeCodeServer.
    if (server === 'jarvis_term') return true

    // The action log and the screen context (this file and context.mjs) only
    // read: ZEN's own log, and what is on the user's own screen.
    if (server === 'jarvis_log' || server === 'jarvis_context' || server === 'jarvis_usage') return true

    // The chief-of-staff tools read the user's own calendar and messages, keep
    // ZEN's own task list, and send nothing without the Allow card that
    // draft_message raises itself (chief.mjs).
    if (server === 'jarvis_life') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    if (READ_VERB.test(tool)) return true
    // One tool, many operations: Grafana's `alerting_manage_rules` is a read
    // with operation "list" and would be an edit with any other. The name says
    // nothing, so read the operation it was actually called with.
    const op = input?.operation ?? input?.action
    if (typeof op === 'string' && (READ_VERB.test(op) || /^(versions|history|status|summary)$/i.test(op))) {
      return true
    }
    return ALLOW_WRITES
  }
  return ALLOW_WRITES
}

// ============================================================ shell reading

const HOME = homedir()
const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * A small shell lexer — enough to find command words, flags, and redirect
 * targets, not a shell. Quotes are honoured so `rm -rf "/"` is still `/`.
 * Anything this can't parse cleanly is still scanned by the whole-text regexes
 * below, which is why both exist: the lexer gives precision for rm and
 * redirects, the regexes give coverage for `bash -c "$(curl …)"` and friends.
 */
function lex(cmd) {
  const out = []
  let cur = null
  const push = () => {
    if (cur !== null) out.push({ word: cur })
    cur = null
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      cur = (cur ?? '') + cmd.slice(i + 1, j < 0 ? cmd.length : j)
      i = j < 0 ? cmd.length : j
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) j++
        s += cmd[j++]
      }
      cur = (cur ?? '') + s
      i = j
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur = (cur ?? '') + cmd[++i]
    } else if (/\s/.test(c) && c !== '\n') {
      push()
    } else if ('\n;&|<>()`'.includes(c)) {
      push()
      const two = cmd.slice(i, i + 2)
      if (['&&', '||', '>>', '<<', '&>'].includes(two)) {
        out.push({ op: two })
        i++
      } else out.push({ op: c })
    } else {
      cur = (cur ?? '') + c
    }
  }
  push()
  return out
}

/** Simple commands (word lists) and every redirect target in a command line. */
function parseShell(cmd) {
  const toks = lex(cmd)
  const segments = []
  const redirects = []
  let seg = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.op === '>' || t.op === '>>' || t.op === '&>') {
      const next = toks[i + 1]
      if (next?.word !== undefined) {
        redirects.push(next.word)
        i++
      }
      continue
    }
    if (t.op === '<' || t.op === '<<') {
      if (toks[i + 1]?.word !== undefined) i++
      continue
    }
    if (t.op) {
      if (seg.length) segments.push(seg)
      seg = []
      continue
    }
    seg.push(t.word)
  }
  if (seg.length) segments.push(seg)
  return { segments: segments.map(unwrap).filter((s) => s.length), redirects }
}

/** Drop `FOO=1`, `env`, `nohup`, `time`, `command`, `exec`, `xargs -0` from the front. */
function unwrap(words) {
  let w = [...words]
  for (;;) {
    if (w.length && /^\w+=/.test(w[0])) w.shift()
    else if (['env', 'nohup', 'time', 'command', 'exec', 'nice', 'caffeinate'].includes(w[0])) w.shift()
    else if (w[0] === 'xargs') {
      w.shift()
      while (w.length && w[0].startsWith('-')) w.shift()
    } else break
  }
  return w
}

const base = (w) => String(w ?? '').split('/').pop()

/** `~`, `$HOME`, `${HOME}` -> the real home, so paths can be compared. */
const expandHome = (p) =>
  String(p).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME)

/** Where a file write is allowed to land at all. Temp dirs are harmless scratch. */
const WRITABLE_ROOTS = [HOME, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()]
const DEV_OK = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/

/** Absolute path (after ~ expansion) that sits outside every writable root. */
function outsideHome(p) {
  const e = expandHome(p)
  if (!e.startsWith('/')) return false // relative: cwd is $HOME
  if (DEV_OK.test(e)) return false
  const r = resolvePath(e)
  return !WRITABLE_ROOTS.some((root) => r === root || r.startsWith(root.endsWith('/') ? root : `${root}/`))
}

/**
 * The rm targets that mean "everything": the root, home, a top-level system
 * folder, a bare wildcard, or a bare variable — `rm -rf $DIR/` with DIR unset
 * is `rm -rf /`, which is how the famous ones happened.
 */
function catastrophicTarget(t) {
  if (/^(\*|\.|\.\/?\*?|\.\.(\/\*?)?|\.\*|~\/?\.\*)$/.test(t)) return true
  if (/^\$\{?\w+\}?\/?\*?$/.test(t) && !/^\$\{?HOME\}?\/\S/.test(t)) return true
  let e = expandHome(t).replace(/\/\*$/, '').replace(/\/+$/, '')
  if (e === '' || e === '/' || e === HOME) return true
  if (!e.startsWith('/')) return false
  e = resolvePath(e)
  // Depth one under / (/usr, /etc, /Users …) or directly /Users/<someone>.
  if (/^\/[^/]+$/.test(e)) return true
  if (/^\/Users\/[^/]+$/.test(e)) return true
  // A glob sitting right under home or root: ~/*/ , /*/x.
  if (/^\/(Users\/[^/]+\/)?\*/.test(e)) return true
  // Every top-level folder of home (Documents, Desktop, work, Library …).
  if (e.startsWith(`${HOME}/`) && !e.slice(HOME.length + 1).includes('/') && /^(Documents|Desktop|Downloads|Library|Pictures|Movies|Music|work|Applications|\.\w+)$/.test(e.slice(HOME.length + 1))) return true
  return false
}

// ================================================================ deny tier

/**
 * Credentials, by path. Used on Bash text and on file tools (Read/Grep
 * included — reading a key is how it leaks). `.env.example` style files carry
 * no secrets and stay readable. Exported because chief.mjs refuses to attach
 * the same files to an email: what ZEN may not read, it may not send either.
 */
export const CRED_PATH = new RegExp(
  [
    String.raw`(^|[\s'"=:/~(])\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|git-credentials|kimi\.env)(\/|\b|$)`,
    String.raw`(^|[\s'"=:/(])\.env(\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?(?=$|[\s'"/;|&)])`,
    String.raw`\.config\/(gh|gcloud|ckh)\b`,
    String.raw`(^|[\s'"=:/(])credentials(\.\w+)?(?=$|[\s'"/;|&)])`,
    String.raw`\.keychain(-db)?\b|Keychains\/`,
    String.raw`\bsecurity\s+(find|dump|export|delete|unlock|add|set)-?(generic|internet|keychain|certificate|identity)?`,
    String.raw`\.string\/(spotify\.json|actions(\.\d)?\.jsonl)`,
  ].join('|'),
  'i',
)

/**
 * Whole-text deny rules for Bash. Each reason is a phrase that gets spoken —
 * "Blocked: that would <reason>" — so none of them contain a command.
 */
const DENY_TEXT = [
  [/(^|[\s;&|(`]|\$\()(sudo|doas)\s|(^|[;&|(\n]\s*)su(\s+-|\s+root|\s*$)/, 'run something as the administrator'],
  [/\b(mkfs(\.\w+)?|newfs(_\w+)?|fdisk)\b|\bdiskutil\s+(erase\w*|zero\w*|secureErase|partitionDisk|reformat|apfs\s+(delete\w*|erase\w*))/i, 'erase or reformat a disk'],
  [/\bdd\b[^;&|\n]*\bof=\/dev\//, 'write raw data over a disk'],
  [/\b(curl|wget)\b[^;\n]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b|\b(curl|wget)\b[^;\n]*\|\s*(python3?|perl|ruby|node)\b|\b(ba|z)?sh\b[^;\n]*(\$\(|<\(|`)\s*(curl|wget)\b|\beval\b[^;\n]*(\$\(|`)\s*(curl|wget)\b/i, 'run a script straight from the internet'],
  [/\bch(mod|own)\s+(-\w+\s+)*-\w*R\w*\s+(\S+\s+)?(\/|~|\$HOME|\/Users)\/?(\s|$|;|&)/, 'change permissions across the whole disk or home folder'],
  [/\bchmod\s+(-\w+\s+)*0?777\s+(\/|~|\$HOME)\/?(\s|$)/, 'change permissions across the whole disk or home folder'],
  [/\b(kill|pkill|killall)\b[^;\n]*\b(whisper|server\.mjs|bridge|zen_pty|node)\b/i, "shut down ZEN's own voice or bridge"],
  [/\b(lsof|pgrep)\b[^;\n]*\|\s*xargs\s+kill\b/, "shut down processes ZEN may depend on"],
  [/\bcrontab\s+-r\b/, 'delete every scheduled job'],
  [/\bgit\s+(-C\s+\S+\s+)?push\b[^;&|\n]*\s--(delete|mirror)\b[^;&|\n]*\b(main|master)\b/, 'delete or overwrite the main branch'],
  [/\bgit\s+(-C\s+\S+\s+)?filter-(branch|repo)\b/, 'rewrite the whole history of a repository'],
]

/** Why a call must never run, as a speakable phrase, or null. */
function denyReason(name, input = {}) {
  if (name === 'Bash') {
    const cmd = String(input.command ?? '')
    for (const [re, why] of DENY_TEXT) if (re.test(cmd)) return why
    if (CRED_PATH.test(cmd)) return 'touch passwords, keys or other credentials'
    const { segments, redirects } = parseShell(cmd)
    for (const w of segments) {
      const c = base(w[0])
      if (c === 'rm' || c === 'rmdir') {
        const flags = w.slice(1).filter((x) => /^-/.test(x))
        const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive')
        const targets = w.slice(1).filter((x) => !/^-/.test(x))
        if (recursive && targets.some(catastrophicTarget)) {
          return 'delete your whole disk, home folder or a broad wildcard'
        }
        if (targets.some(outsideHome)) return 'delete files outside your home folder'
      }
      if (c === 'git' && w.includes('push')) {
        const force = w.some((x) => /^(-f|--force|--force-with-lease(=.*)?|-\w*f\w*)$/.test(x) || /^\+/.test(x))
        if (force && w.some((x) => /(^|[:+/])(main|master)$/.test(x))) return 'force-push over the main branch'
      }
      if (['kill', 'pkill', 'killall'].includes(c)) {
        const pids = [String(process.pid), String(process.ppid)]
        if (w.some((x) => pids.includes(x))) return "shut down ZEN's own bridge"
      }
      if (['tee', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'ln', 'install'].includes(c)) {
        if (w.slice(1).filter((x) => !/^-/.test(x)).some(outsideHome)) return 'write outside your home folder'
      }
      if (['cp', 'mv', 'rsync', 'ditto'].includes(c)) {
        const args = w.slice(1).filter((x) => !/^-/.test(x))
        const dest = args[args.length - 1]
        if (args.length >= 2 && !/^[\w.-]+@?[\w.-]*:/.test(dest) && outsideHome(dest)) return 'write outside your home folder'
      }
      if (c === 'sed' && w.some((x) => /^-i/.test(x))) {
        if (w.slice(1).some((x) => x.startsWith('/') && outsideHome(x))) return 'write outside your home folder'
      }
    }
    if (redirects.some((r) => /^\/dev\//.test(r) && !DEV_OK.test(r))) return 'write raw data over a device'
    if (redirects.some(outsideHome)) return 'write outside your home folder'
    return null
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const p = String(input.file_path ?? input.notebook_path ?? '')
    if (CRED_PATH.test(p)) return 'change a file holding passwords, keys or credentials'
    if (outsideHome(p)) return 'write outside your home folder'
    if (expandHome(p).startsWith(join(HOME, '.string') + '/')) return "rewrite ZEN's own records"
    return null
  }

  if (['Read', 'Grep', 'Glob', 'NotebookRead'].includes(name)) {
    const p = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
    const g = name === 'Glob' ? '' : String(input.glob ?? '')
    if (CRED_PATH.test(p) || CRED_PATH.test(g)) return 'read passwords, keys or credentials'
    return null
  }
  return null
}

// ================================================================= ask tier

/**
 * Lines of a command that only look at text. `grep "git push" notes.md`
 * mentions a push without doing one, so viewer steps are dropped before the
 * always-ask rules run — unless they hide a substitution, -exec, or an
 * in-place edit. (The deny rules never get this leniency.)
 */
const VIEWER = /^\s*(grep|egrep|fgrep|rg|cat|head|tail|less|wc|ls|diff|stat|file|echo|printf|sed\s+-n|git\s+(log|show|diff|grep|status|blame))\s/
function checkedText(cmd) {
  if (/<</.test(cmd)) return cmd
  return cmd
    .split(/\n|;|&&|\|\||\|/)
    .filter((seg) => !(VIEWER.test(seg) && !/\$\(|`|-exec\b|-delete\b|\s-i\b/.test(seg)))
    .join('\n')
}

/**
 * Bash that always asks, ALLOW_WRITES or not: it reaches other people, other
 * machines, or production, or it is hard to take back. Lifted largely from the
 * reference PreToolUse hook, widened to installs, deploys and remote shells.
 */
const ASK_TEXT = [
  [/\bgit\s+(-C\s+\S+\s+)?push\b/, 'pushes code'],
  [/\bgh\s+(pr\s+(merge|close|create|comment|review|edit)|release\s+create|repo\s+(delete|create|edit)|issue\s+(create|comment|close|edit)|api\b[^\n;]*-X\s*(POST|PATCH|PUT|DELETE))\b/i, 'changes GitHub'],
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'deletes files recursively'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s+\.|stash\s+(drop|clear))/, 'throws away uncommitted work'],
  [/\b(npm|pnpm|bun)\s+(i|install|add|ci|update|upgrade|remove|uninstall|rm|link)\b|\byarn\s+(install|add|upgrade|remove|global)\b|(^|[;&|\n]\s*)yarn\s*($|[;&|\n])|\b(pip3?|pipx|gem|cargo|brew|apt(-get)?|port|conda|mamba|poetry)\s+(install|add|upgrade|uninstall|remove|reinstall|tap)\b|\buv\s+(pip\s+install|add|tool\s+install)\b|\bgo\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\b(npx|bunx|uvx|pnpx)\s/i, 'installs software'],
  [/\b(npm|pnpm|yarn|cargo|twine|gem|poetry|bun)\s+publish\b|\bdocker\s+push\b|--push\b/, 'publishes a package or image'],
  [/\b(vercel|netlify|fly(ctl)?|firebase|wrangler|railway|heroku|serverless|sls|amplify|surge|gcloud\s+app|eb)\b[^\n;&|]*\b(deploy|up|publish|release|--prod)\b|\b(cdk|sam)\s+(deploy|destroy)\b|\bpulumi\s+(up|destroy)\b|\bansible-playbook\b/i, 'deploys something'],
  [/\bkubectl\s+(apply|create|delete|edit|patch|replace|rollout|scale|set|annotate|label|drain|cordon|exec)\b/i, 'changes a Kubernetes cluster'],
  [/\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b/i, 'changes a Helm release'],
  [/\bterraform\s+(apply|destroy|import|state\s+(rm|mv|push))\b/i, 'changes infrastructure'],
  [/\b(psql|mysql|clickhouse(-client)?|redis-cli|mongosh?|sqlite3)\b[\s\S]*\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|database|view)|alter\s+table|truncate|create\s+(table|database)|flushall|flushdb)\b/i, 'writes to a database'],
  [/\bckh\s+(rw|boss)\b/, 'writes to a database'],
  [/\bcurl\b[\s\S]*\b(insert\s+into|alter\s+table|drop\s+table|truncate\s+table|delete\s+from)\b/i, 'writes to a database over HTTP'],
  [/\baws\s+\S+\s+(delete|put|create|update|terminate|modify|run-instances|start|stop|reboot|attach|detach|invoke)[-\w]*|\baws\s+s3\s+(cp|mv|rm|sync|rb|mb)\b/i, 'changes AWS resources'],
  [/\bgcloud\b[\s\S]*\b(delete|create|update|deploy|set|add-iam-policy-binding|ssh)\b|\bgsutil\s+(cp|mv|rm|rsync)\b/i, 'changes Google Cloud resources'],
  [/\baz\s+\S+[\s\S]*\b(create|delete|update|set|deploy|start|stop|restart)\b/i, 'changes Azure resources'],
  [/(^|[;&|\n(]\s*)(ssh|scp|sftp|mosh)\s|\brsync\b[^\n;]*\s[\w.-]+@?[\w.-]+:/, 'runs on or copies to another machine'],
  [/\b(smtplib|sendmail|nodemailer|mutt|msmtp)\b|(^|[;&|\n]\s*)mail\s+-s\b/i, 'sends an email'],
  [/osascript[\s\S]*\b(Messages|iMessage|Mail)\b[\s\S]*\bsend\b|osascript[\s\S]*\bsend\b[\s\S]*\b(Messages|iMessage|Mail)\b/i, 'sends a message'],
  [/hooks\.slack\.com|slack\.com\/api\/chat|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot[^\s]*\/send|api\.twilio\.com|graph\.facebook\.com|api\.sendgrid\.com|api\.mailgun\.net/i, 'sends a message to other people'],
  [/\b(checkout|place[_ -]?order|pay(ment)?[_ -]?(confirm|submit)|upi)\b/i, 'looks like a payment'],
  [/\b(shutdown|reboot|halt)\b|\bpmset\s+(sleepnow|restoredefaults)\b/, 'restarts or shuts down the Mac'],
  [/\bcrontab\b(?!\s+-l)|\blaunchctl\s+(load|bootstrap|enable|submit)\b/, 'schedules something to run automatically'],
  [/\bdefaults\s+(write|delete)\b|\b(networksetup|scutil)\s+-?set/, 'changes system settings'],
  [/(^|[\s/='"_.:-])(prod|production|prd)([\s/'"_.:-]|$)/i, 'touches something that looks like production'],
]

/** ZEN's own safety code and server: changing them always needs a yes. */
const SELF = new RegExp(`${BRIDGE_DIR.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/(gate|server|context)\\.mjs|bridge/(gate|server)\\.mjs`)

/** MCP verbs that reach other people or are hard to undo. */
const MCP_ASK_VERB =
  /(send|mail|email|message|post|publish|deploy|reply|tweet|invite|share|comment|notify|call|outbound|sms|whatsapp|release|merge|delete|remove|destroy|drop|purge|pay|charge|buy|purchase|transfer|order)/i

/** Why a call needs the card even with ALLOW_WRITES on, or null. */
function alwaysAskReason(name, input = {}) {
  if (name === 'Bash') {
    const cmd = String(input.command ?? '')
    const t = checkedText(cmd)
    for (const [re, why] of ASK_TEXT) if (re.test(t)) return why
    if (SELF.test(cmd) && /(sed\s+-i|>|\btee\b|\bmv\b|\bcp\b|\brm\b|python3?\s|node\s+-e|perl\s+-[pi])/.test(cmd)) {
      return "changes ZEN's own safety code"
    }
    return null
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const p = String(input.file_path ?? input.notebook_path ?? '')
    if (SELF.test(expandHome(p))) return "changes ZEN's own safety code"
    if (/(^|[\s/='"_.:-])(prod|production|prd)([\s/'"_.:-]|$)/i.test(p)) return 'touches something that looks like production'
    return null
  }
  const server = mcpServerOf(name)
  if (server && !OWN_SERVERS.has(server)) {
    const tool = mcpToolOf(name)
    if (VETO_EXEMPT.has(`${server}__${tool}`)) return null
    // `notion-get-comments` is a read: strip the server's own prefix so the
    // read verb is seen, and let a leading read verb win over a noun like
    // "comments" further along.
    const bare = tool.replace(new RegExp(`^${server.replace(/[^\w]/g, '.')}[-_]`, 'i'), '')
    if (READ_VERB.test(bare)) return null
    const op = input?.operation ?? input?.action
    if (typeof op === 'string' && READ_VERB.test(op)) return null
    const m = bare.match(MCP_ASK_VERB)
    if (m) return `would ${m[1].toLowerCase()} on ${server}`
  }
  return null
}

// ============================================================== action log

/**
 * One JSON object per line, appended. Not a database: it is written from one
 * process, read rarely, and has to survive the bridge dying mid-write — an
 * append-only text file is the thing least likely to lose the entry that
 * matters. At ~2 MB it rolls to actions.1.jsonl (one generation kept), which
 * is weeks of voice use.
 */
const ACTIONS_FILE = () => process.env.ZEN_ACTIONS_FILE || join(HOME, '.string', 'actions.jsonl')
const ROTATE_AT = 2 * 1024 * 1024

/**
 * Secrets out of anything logged. The log is read back aloud and shown on
 * screen, so a token pasted into a curl must not live there.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '$1-•••')
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}/g, '$1_•••')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, 'xox•••')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA•••')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza•••')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 •••')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:•••@')
    .replace(/((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth|authorization|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1•••')
    .replace(/(-p|--password[= ])\s?\S+/g, '$1•••')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '<hex>')
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '<secret?>')
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function logAction(entry) {
  const file = ACTIONS_FILE()
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > ROTATE_AT) renameSync(file, file.replace(/\.jsonl$/, '') + '.1.jsonl')
    } catch {}
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    // Logging must never be the reason a tool call fails.
    console.warn('[gate] could not write action log:', err.message)
  }
}

function readActions() {
  const file = ACTIONS_FILE()
  const rows = []
  for (const f of [file.replace(/\.jsonl$/, '') + '.1.jsonl', file]) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {}
    }
  }
  return rows
}

/** What the call is, in words, plus the exact command or path when there is one. */
function detailOf(name, input = {}) {
  if (name === 'Bash') return String(input.command ?? '')
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(name)) return String(input.file_path ?? input.notebook_path ?? '')
  if (['Grep', 'Glob'].includes(name)) return [input.pattern, input.path].filter(Boolean).join(' in ')
  return ''
}

// ==================================================================== gate

const DENY_PREFIX = 'Blocked by ZEN safety rules: that would '
const deny = (message) => ({ behavior: 'deny', message })
const allow = (input) => ({ behavior: 'allow', updatedInput: input ?? {} })

/**
 * The gate itself.
 *
 *   ask      — the bridge's request/reply channel. `ask('approve', { text },
 *              ms)` resolves with `{ ok }` or rejects ("not connected" / "did
 *              not answer in time"). Optional: with none, the ask tier is a
 *              speakable no. May be swapped later with setAsk (each browser
 *              connection brings its own socket).
 *   describe — (name, input) → the HUD's sentence for the call.
 *
 * check() is shaped for the SDK's canUseTool: it takes (toolName, input,
 * options) and returns a PermissionResult. `updatedInput` is always set on
 * allow — older SDK builds validated it as required and a bare
 * `{behavior:'allow'}` came back as a schema error.
 *
 * Cards are serialised: two parallel tool calls must not stack two cards, or
 * the user's tap could land on the wrong one.
 *
 * hook() is the same decision as a PreToolUse hook. canUseTool is only
 * consulted for calls the CLI has not already settled itself; a hook runs for
 * every call. Wire both and a call is decided once — the toolUseID is
 * remembered so the second path returns the first verdict without a second
 * card or log line.
 */
export function makeGate({ ask = null, describe = (n) => n } = {}) {
  let askFn = ask
  let queue = Promise.resolve()
  const decided = new Map() // toolUseID -> PermissionResult

  const card = (text) => {
    const run = queue.then(async () => {
      if (typeof askFn !== 'function') return 'unavailable'
      try {
        const r = await askFn('approve', { text }, 120_000)
        return r?.ok === true ? 'yes' : 'no'
      } catch (err) {
        return /not connected|closed/i.test(String(err?.message)) ? 'unavailable' : 'timeout'
      }
    })
    queue = run.catch(() => {})
    return run
  }

  async function decide(toolName, input = {}, signal) {
    let summary
    try {
      const d = detailOf(toolName, input)
      const words = String(describe(toolName, input) ?? toolName).replace(/…$/, '')
      summary = cut(redact(d ? `${words} — ${d}` : words), 200)
    } catch {
      summary = toolName
    }
    const log = (tier, decision, approved, reason) =>
      logAction({ ts: new Date().toISOString(), tool: toolName, summary, tier, decision, approved, ...(reason ? { reason } : {}) })

    const hard = denyReason(toolName, input)
    if (hard) {
      log('deny', 'deny', false, hard)
      console.log(`[gate] ${toolName} -> deny (${hard})`)
      return deny(`${DENY_PREFIX}${hard}, which is never allowed, even with approval. Tell the user it is off limits and offer to explain how they could do it themselves.`)
    }

    const always = alwaysAskReason(toolName, input)
    if (!always && decideTool(toolName, input)) {
      log('auto', 'allow', null)
      return allow(input)
    }

    const reason =
      always ??
      (WRITE_BUILTINS.has(toolName) ? 'changes files or runs a command' : 'can change things outside ZEN')
    if (signal?.aborted) {
      log('ask', 'deny', false, `${reason}; turn interrupted`)
      return deny('Cancelled: the turn was interrupted before the user answered.')
    }
    const words = String(describe(toolName, input) ?? toolName).replace(/…$/, '')
    const d = detailOf(toolName, input)
    const text = `${words}\nThis ${reason}.${d ? `\n\n${cut(d, 600)}` : ''}`
    const verdict = await card(text)
    console.log(`[gate] ${toolName} -> ask (${reason}) -> ${verdict}`)
    if (verdict === 'yes') {
      log('ask', 'allow', true, reason)
      return allow(input)
    }
    log('ask', 'deny', false, `${reason}; ${verdict === 'no' ? 'declined' : verdict}`)
    if (verdict === 'no') return deny('The user declined this on the approval card. Do not retry it; ask what they would like instead.')
    if (verdict === 'timeout') return deny('Not done: nobody answered the approval card in time. Tell the user it is waiting for their OK if they still want it.')
    return deny('Not done: this needs the user’s approval on screen, and the ZEN screen is not connected. Tell the user it needs their OK in ZEN.')
  }

  async function check(toolName, input = {}, options = {}) {
    const id = options?.toolUseID
    if (id && decided.has(id)) return decided.get(id)
    const result = await decide(toolName, input, options?.signal)
    if (id) {
      decided.set(id, result)
      if (decided.size > 500) decided.delete(decided.keys().next().value)
    }
    return result
  }

  /** The same verdict as a PreToolUse hook callback (SDK HookCallback). */
  async function hook(hookInput, toolUseID, options) {
    if (hookInput?.hook_event_name !== 'PreToolUse') return {}
    const r = await check(hookInput.tool_name, hookInput.tool_input ?? {}, { toolUseID, signal: options?.signal })
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: r.behavior,
        ...(r.behavior === 'deny' ? { permissionDecisionReason: r.message } : {}),
      },
    }
  }

  return { check, hook, setAsk: (fn) => (askFn = fn) }
}

/** The tier a call would get, without asking or logging. For tests and the HUD. */
export function classify(toolName, input = {}) {
  const hard = denyReason(toolName, input)
  if (hard) return { tier: 'deny', reason: hard }
  const always = alwaysAskReason(toolName, input)
  if (!always && decideTool(toolName, input)) return { tier: 'auto', reason: null }
  return { tier: 'ask', reason: always ?? 'write' }
}

// ========================================================= recent_actions

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * "What did you do today?" — answered from the log, not from the model's
 * memory of the conversation, which forgets everything at the next session.
 */
export function actionsServer() {
  return createSdkMcpServer({
    name: 'jarvis_log',
    version: '1.0.0',
    tools: [
      tool(
        'recent_actions',
        "ZEN's own log of tool calls it made or tried to make, newest first: what, when, and whether it ran " +
          'automatically, was approved or declined on the card, or was blocked by the safety rules. Use it ' +
          'when the user asks what you did, what you asked about, or what was blocked. Summarise; never read ' +
          'commands aloud.',
        {
          limit: z.number().int().min(1).max(200).optional().describe('How many entries (default 20).'),
          filter: z
            .enum(['all', 'asked', 'denied', 'today'])
            .optional()
            .describe('asked = went to the approval card; denied = did not run; today = since local midnight.'),
        },
        async ({ limit = 20, filter = 'all' }) => {
          try {
            let rows = readActions()
            if (filter === 'asked') rows = rows.filter((r) => r.tier === 'ask')
            if (filter === 'denied') rows = rows.filter((r) => r.decision === 'deny')
            if (filter === 'today') {
              const midnight = new Date()
              midnight.setHours(0, 0, 0, 0)
              rows = rows.filter((r) => Date.parse(r.ts) >= midnight.getTime())
            }
            rows = rows.slice(-limit).reverse()
            if (!rows.length) return ok('No matching actions in the log.')
            return ok(
              rows
                .map((r) => {
                  const t = new Date(r.ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
                  const how =
                    r.tier === 'auto' ? 'ran' : r.tier === 'deny' ? 'blocked' : r.approved ? 'approved, ran' : `not run (${String(r.reason ?? '').split('; ').pop()})`
                  return `${t} · ${how} · ${r.summary}`
                })
                .join('\n'),
            )
          } catch (err) {
            return fail(`Could not read the action log: ${err.message}`)
          }
        },
      ),
      // "How much have you cost today?" lives beside "what did you do today?".
      usageTool(),
    ],
  })
}
