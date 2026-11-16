import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What ZEN costs to run.
 *
 * Every finished turn is one line in ~/.string/usage.jsonl: when, which model,
 * what kind of turn (voice, a background job, a briefing), tokens, and dollars.
 * The point is "how much have you cost today?" answered from a record rather
 * than a guess — and noticing early when one kind of turn is quietly the
 * expensive one.
 *
 * The dollars are the SDK's own figure when it gives one (result.total_cost_usd)
 * and a list-price estimate from the token counts when it doesn't. Behind a
 * subscription or another provider's gateway neither is a bill; it is a
 * yardstick for how heavy each part is.
 */

const FILE = () => process.env.ZEN_USAGE_FILE || join(homedir(), '.string', 'usage.jsonl')
const ROTATE_AT = 2 * 1024 * 1024

/** $ per million tokens: input, output, cache read, cache write. Matched on the model id. */
const PRICE = [
  [/opus/i, 5, 25, 0.5, 6.25],
  [/sonnet/i, 3, 15, 0.3, 3.75],
  [/haiku/i, 1, 5, 0.1, 1.25],
]
export function estimateUsd(model, u = {}) {
  const p = PRICE.find(([re]) => re.test(String(model ?? ''))) ?? PRICE[0]
  const i = u.input_tokens ?? 0
  const o = u.output_tokens ?? 0
  const cr = u.cache_read_input_tokens ?? 0
  const cw = u.cache_creation_input_tokens ?? 0
  return (i * p[1] + o * p[2] + cr * p[3] + cw * p[4]) / 1e6
}

/**
 * The SDK reports total_cost_usd on each `result`. In a long-lived streaming
 * session that figure can be cumulative for the session rather than per turn,
 * so callers who only have the running total pass it as `totalCostUsd` with a
 * `sessionId`, and the per-turn cost is the difference from the last one seen.
 * A total that goes down means a new session: the whole figure counts.
 */
const lastTotal = new Map()

/**
 * Record one turn. Pass whichever you have:
 *   costUsd       — this turn's cost
 *   totalCostUsd  + sessionId — the session's running total (delta is taken)
 *   usage         — the SDK usage block (input/output/cache tokens); used for
 *                   token counts, and for the estimate if no cost is given
 * Never throws: accounting must not break a turn.
 */
export function recordTurn({ costUsd, totalCostUsd, sessionId, model, kind = 'voice', usage, durationMs } = {}) {
  try {
    let usd = typeof costUsd === 'number' ? costUsd : null
    if (usd === null && typeof totalCostUsd === 'number') {
      const key = sessionId ?? 'default'
      const prev = lastTotal.get(key) ?? 0
      usd = totalCostUsd >= prev ? totalCostUsd - prev : totalCostUsd
      lastTotal.set(key, totalCostUsd)
    }
    const estimated = usd === null
    if (estimated) usd = usage ? estimateUsd(model, usage) : 0
    const row = {
      ts: new Date().toISOString(),
      kind,
      model: model ?? null,
      usd: Math.round(usd * 1e6) / 1e6,
      ...(estimated ? { estimated: true } : {}),
      in: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
      out: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      ...(typeof durationMs === 'number' ? { ms: durationMs } : {}),
    }
    const file = FILE()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > ROTATE_AT) renameSync(file, file.replace(/\.jsonl$/, '') + '.1.jsonl')
    } catch {}
    appendFileSync(file, `${JSON.stringify(row)}\n`)
    return row
  } catch (err) {
    console.warn('[usage] could not record turn:', err.message)
    return null
  }
}

function readRows() {
  const file = FILE()
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

/** Totals for today (local midnight) and the last 7 days, overall and by kind. */
export function usageSummary() {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const weekStart = Date.now() - 7 * 86400e3
  const bucket = () => ({ turns: 0, usd: 0, in: 0, out: 0 })
  const out = { today: { all: bucket(), byKind: {} }, week: { all: bucket(), byKind: {} } }
  for (const r of readRows()) {
    const at = Date.parse(r.ts)
    if (!(at >= weekStart)) continue
    for (const span of at >= midnight.getTime() ? ['today', 'week'] : ['week']) {
      for (const b of [out[span].all, (out[span].byKind[r.kind] ??= bucket())]) {
        b.turns++
        b.usd += r.usd ?? 0
        b.in += r.in ?? 0
        b.out += r.out ?? 0
      }
    }
  }
  return out
}

const money = (n) => (n < 0.01 && n > 0 ? 'under a cent' : `$${n.toFixed(2)}`)
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

/** The `usage` tool, for the jarvis_log server (see gate.mjs actionsServer). */
export const usageTool = () =>
  tool(
    'usage',
    "How much ZEN has cost to run: today and the last 7 days, in dollars, turns and tokens, split by kind of turn. " +
      'Use when the user asks what you cost, how much you have been used, or which part is expensive. Say the ' +
      'figure plainly; it is a list-price estimate, not a bill.',
    { span: z.enum(['today', 'week', 'both']).optional().describe('Default both.') },
    async ({ span = 'both' }) => {
      try {
        const s = usageSummary()
        const fmt = (name, b) => {
          const kinds = Object.entries(b.byKind)
            .sort((a, z2) => z2[1].usd - a[1].usd)
            .map(([k, v]) => `${k} ${money(v.usd)} (${v.turns})`)
            .join(', ')
          return `${name}: ${money(b.all.usd)} over ${b.all.turns} turns, ${tok(b.all.in)} tokens in / ${tok(b.all.out)} out${kinds ? ` — ${kinds}` : ''}`
        }
        const lines = []
        if (span !== 'week') lines.push(fmt('Today', s.today))
        if (span !== 'today') lines.push(fmt('Last 7 days', s.week))
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Could not read usage: ${err.message}` }] }
      }
    },
  )

/** Standalone server, if you'd rather not ride on jarvis_log. */
export const usageServer = () => createSdkMcpServer({ name: 'jarvis_usage', version: '1.0.0', tools: [usageTool()] })
