import Anthropic from '@anthropic-ai/sdk'

/**
 * One tool-less model call, for the jobs that sort and summarise rather than
 * act: inbox triage, promise spotting, meeting briefs, the fast lane, the
 * "talking to ZEN or about ZEN?" check.
 *
 * Tool-less on purpose. What goes in here is other people's text (a message,
 * a mail, a sentence heard in the room), so the model gets nothing it could be
 * talked into using: it can only return words, and callers that want JSON
 * validate what comes back.
 *
 * Same gateway and credentials as the agent (.kimi.env); the small model by
 * default, since these run often and are short.
 */

const SMALL = process.env.STRING_SMALL_MODEL || process.env.ANTHROPIC_SMALL_FAST_MODEL || 'claude-haiku-4-5'
const BIG = process.env.JARVIS_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

let client = null
const api = () =>
  (client ??= new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || 'none',
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  }))

/**
 * @param {{ system?: string, prompt: string, big?: boolean, maxTokens?: number, timeoutMs?: number }} o
 * @returns {Promise<string>} the text of the answer ('' on an empty reply); throws on failure
 */
export async function complete({ system, prompt, big = false, maxTokens = 800, timeoutMs = 30_000 }) {
  const res = await api().messages.create(
    {
      model: big ? BIG : SMALL,
      // Reasoning models spend part of the budget thinking before they write.
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: timeoutMs, maxRetries: 1 },
  )
  return (res.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** Pull the first JSON object or array out of a reply that may carry prose or fences around it. */
export function parseJson(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '')
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0)
  if (!starts.length) return null
  const start = Math.min(...starts)
  const close = t[start] === '{' ? '}' : ']'
  const end = t.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/** complete() + parseJson(); null when the call fails or nothing parses. */
export async function completeJson(o) {
  try {
    return parseJson(await complete(o))
  } catch (err) {
    console.warn('[llm]', err?.message ?? err)
    return null
  }
}
