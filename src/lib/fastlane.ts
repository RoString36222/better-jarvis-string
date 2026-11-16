import { BRIDGE_HTTP_URL } from '../config'

/**
 * The page's side of the fast lane (bridge/fastlane.mjs) and the wake check
 * (bridge/wake.mjs), plus the two short memories they read.
 *
 * Spoken exchanges. The fast lane answers without the agent, so it has no
 * session to remember the conversation. "What's the capital of Australia?" →
 * "Canberra." → "and how far is it from Sydney?" only makes sense with the
 * exchange before it. The last few things ZEN said aloud, with the questions
 * that got them, are kept here and sent along. Spoken exchanges only — what
 * he already heard — never panels or tool output.
 *
 * The room (see roomContext in voice.ts): with the wake word on, what the mic
 * heard WITHOUT the name in the last 30 s, kept in memory only, so "…Zen,
 * what do you think?" has something to think about.
 */

export type Exchange = { q: string; a: string; at: number }

const MAX = 4
const recentExchanges: Exchange[] = []
/**
 * Fast-lane answers the agent session hasn't seen. The agent keeps its own
 * conversation; without these, "and its population?" after a fast answer
 * would reach it with no idea what "its" is. Cleared once they are passed on.
 */
let unseen: Exchange[] = []

/** Remember one spoken exchange, from whichever path answered it. */
export function recordExchange(q: string, a: string, opts: { agentSaw: boolean }) {
  const ex = { q: q.slice(0, 400), a: a.replace(/\s+/g, ' ').trim().slice(0, 400), at: Date.now() }
  if (!ex.q || !ex.a) return
  recentExchanges.push(ex)
  while (recentExchanges.length > MAX) recentExchanges.shift()
  if (!opts.agentSaw) {
    unseen.push(ex)
    unseen = unseen.slice(-2)
  }
}

/** The exchanges of the last ten minutes, for the fast lane. */
export const recent = (): { q: string; a: string }[] =>
  recentExchanges.filter((x) => Date.now() - x.at < 10 * 60_000).map(({ q, a }) => ({ q, a }))

/** The same, as the wake check's chat lines (who said it, how long ago). */
const chat = () =>
  recentExchanges
    .filter((x) => Date.now() - x.at < 10 * 60_000)
    .flatMap((x) => {
      const ago_sec = Math.round((Date.now() - x.at) / 1000)
      return [
        { who: 'him', text: x.q, ago_sec },
        { who: 'zen', text: x.a, ago_sec },
      ]
    })

/** How a request reached ZEN, when it came from the room rather than Space. */
export type Heard = { fromRoom: boolean; context: string[] }

/**
 * What to send the agent: his words, preceded by what it should know about
 * them. Plain marked lines, because the agent reads them as part of his
 * message:
 *  - heard by the always-on mic: the speaker isn't certain (a video, a guest);
 *  - the room just before, when there was any ("…what do you think?");
 *  - the quick answers it missed.
 */
export function forAgent(said: string, heard?: Heard | null): string {
  const lines: string[] = []
  if (heard?.fromRoom) lines.push('[Heard by the always-on mic]')
  if (heard?.context.length) {
    const ctx = heard.context.map((l) => `"${l.replace(/\s+/g, ' ').slice(0, 300)}"`).join(' / ')
    lines.push(`[Heard in the room just before — may be other people or a video: ${ctx}]`)
  }
  if (unseen.length) {
    const ctx = unseen.map((x) => `he asked "${x.q}" and you answered "${x.a}"`).join('; ')
    lines.push(`[Just before this, answered aloud without you: ${ctx}]`)
    unseen = []
  }
  return lines.length ? `${lines.join('\n')}\n\n${said}` : said
}

/**
 * Ask the fast lane. The answer to speak, or null to ask the agent as usual.
 *
 * Always tried rather than pre-filtered here: the bridge's rules turn away an
 * action or a personal question in well under a millisecond, so the cost of a
 * "no" is one localhost round trip, and the rules live in one place. The
 * abort sits just above the bridge's own 6 s model timeout, so a hung bridge
 * can never hold an answer back for longer than that.
 */
export async function askFast(text: string, context: string[] = []): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/fast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, recent: recent(), context }),
      signal: AbortSignal.timeout(6500),
    })
    if (!res.ok) return null
    const out = (await res.json()) as { answer?: unknown; handoff?: unknown }
    return typeof out.answer === 'string' && out.answer.trim() ? out.answer.trim() : null
  } catch {
    return null
  }
}

export type WakeKind = 'call' | 'question' | 'command' | 'mention'
export type WakeVerdict = { addressed: boolean; kind: WakeKind; request: string; by: string }

/**
 * Was a sentence with his name in it said TO ZEN, and what does he want?
 * Fails open: no bridge, an old bridge without the route, or 2.5 s without an
 * answer all mean yes, with his words as the request — a missed request costs
 * him a repeat, which is worse than the odd wrong wake.
 */
export async function wakeCheck(text: string, context: string[] = []): Promise<WakeVerdict> {
  const open: WakeVerdict = { addressed: true, kind: 'command', request: text, by: 'fail-open' }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/wake-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context, chat: chat(), followup: null }),
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) return open
    const out = (await res.json()) as Partial<WakeVerdict> & { to?: unknown }
    const addressed = typeof out.addressed === 'boolean' ? out.addressed : typeof out.to === 'boolean' ? out.to : null
    if (addressed === null) return open
    const kind = (['call', 'question', 'command', 'mention'] as const).find((k) => k === out.kind) ?? 'command'
    return {
      addressed,
      kind: addressed ? kind : 'mention',
      request: typeof out.request === 'string' ? out.request : addressed ? text : '',
      by: typeof out.by === 'string' ? out.by : 'model',
    }
  } catch {
    return open
  }
}
