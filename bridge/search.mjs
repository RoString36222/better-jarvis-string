import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Web search that does not depend on the model provider.
 *
 * Claude Code's built-in WebSearch runs on Anthropic's side, so behind any
 * other gateway (the org's Kimi, say) it simply reports itself down and the
 * model falls back to fetching pages one by one for minutes. This is the
 * replacement, and it picks the best source it has a key for:
 *
 *   SERPER_API_KEY        Google results via serper.dev
 *   BRAVE_SEARCH_API_KEY  Brave Search API
 *   (neither)             Wikipedia — keyless and dependable, encyclopaedic only
 *
 * Scraping a search page is not on the list: DuckDuckGo and Bing both serve
 * scripts a challenge or junk results, which is worse than an honest
 * "Wikipedia only".
 */

const TIMEOUT_MS = 12_000

const get = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return res.json()
}

async function serper(q, n) {
  const data = await get('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: n }),
  })
  return (data.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }))
}

async function brave(q, n) {
  const data = await get(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`,
    { headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY, Accept: 'application/json' } },
  )
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: String(r.description ?? '').replace(/<[^>]+>/g, ''),
  }))
}

async function wikipedia(q, n) {
  const ua = { headers: { 'User-Agent': 'STRING-assistant/1.0 (local voice assistant)' } }
  const found = await get(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${n}` +
      `&srsearch=${encodeURIComponent(q)}`,
    ua,
  )
  const hits = found.query?.search ?? []
  if (!hits.length) return []
  // The search snippet is a sentence fragment; the intro extract is what
  // actually carries figures, so fetch those for every hit in one request.
  const ids = hits.map((h) => h.pageid).join('|')
  const pages = await get(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages&exintro=1&explaintext=1` +
      `&exchars=1200&piprop=original&format=json&pageids=${ids}`,
    ua,
  )
  return hits.map((h) => {
    const p = pages.query?.pages?.[h.pageid] ?? {}
    return {
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: p.extract ?? h.snippet.replace(/<[^>]+>/g, ''),
      image: p.original?.source,
    }
  })
}

export const searchSource = () =>
  process.env.SERPER_API_KEY ? 'serper' : process.env.BRAVE_SEARCH_API_KEY ? 'brave' : 'wikipedia'

const DESCRIPTION = () => `Search the web. Returns titles, URLs and snippets.

This is your search tool — the built-in WebSearch is not available. Current
source: ${searchSource()}${
  searchSource() === 'wikipedia'
    ? ' (Wikipedia only: good for background, companies, products and history; ' +
      'it will not have breaking news or live prices — say so if that is what was asked)'
    : ''
}. Results with an \`image\` field carry a picture URL you may put on a blade.
Prefer two or three focused searches over many: read the snippets, fetch a page
only when the snippet lacks the figure you need.`

export function searchServer() {
  return createSdkMcpServer({
    name: 'jarvis_search',
    version: '1.0.0',
    tools: [
      tool(
        'web_search',
        DESCRIPTION(),
        {
          query: z.string().describe('What to search for.'),
          count: z.number().int().min(1).max(10).optional().catch(undefined),
        },
        async (args) => {
          const q = String(args.query ?? '').trim()
          if (!q) return { isError: true, content: [{ type: 'text', text: 'Empty query.' }] }
          const n = args.count ?? 6
          const source = searchSource()
          try {
            const results =
              source === 'serper' ? await serper(q, n) : source === 'brave' ? await brave(q, n) : await wikipedia(q, n)
            const text = results.length
              ? JSON.stringify({ source, results }, null, 1)
              : `No results from ${source} for "${q}". Try fewer or different words.`
            return { content: [{ type: 'text', text }] }
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Search failed (${source}): ${err?.message ?? err}` }],
            }
          }
        },
      ),
    ],
  })
}
