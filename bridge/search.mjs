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

export async function wikipedia(q, n) {
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


// ---------------------------------------------------------------- weather

/**
 * Old names the geocoder does not know, or knows as somewhere else entirely:
 * "Bangalore" resolves to a town in Pakistan.
 */
const CITY_ALIASES = {
  bangalore: 'Bengaluru', bombay: 'Mumbai', madras: 'Chennai', calcutta: 'Kolkata',
  mysore: 'Mysuru', trivandrum: 'Thiruvananthapuram', cochin: 'Kochi', poona: 'Pune',
  gurgaon: 'Gurugram', baroda: 'Vadodara', mangalore: 'Mangaluru',
}
const HOME_CITY = process.env.STRING_HOME_CITY || 'Bengaluru'

/** WMO weather codes, as words that read well aloud. */
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain',
  65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow',
  75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail',
  99: 'severe thunderstorm with hail',
}

async function weather(place, days) {
  const asked = String(place ?? '').trim() || HOME_CITY
  const name = CITY_ALIASES[asked.toLowerCase()] ?? asked
  const geo = await get(
    `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&name=${encodeURIComponent(name)}`,
  )
  // Most populous match: "Chennai" should not resolve to the airport.
  const hit = [...(geo.results ?? [])].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0]
  if (!hit) return null
  const f = await get(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&forecast_days=${days}&timezone=auto`,
  )
  const c = f.current ?? {}
  const d = f.daily ?? {}
  return {
    place: `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ''}, ${hit.country}`,
    local_time: c.time,
    now: {
      conditions: WMO[c.weather_code] ?? `code ${c.weather_code}`,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
    },
    days: (d.time ?? []).map((date, i) => ({
      date,
      conditions: WMO[d.weather_code?.[i]] ?? `code ${d.weather_code?.[i]}`,
      high_c: d.temperature_2m_max?.[i],
      low_c: d.temperature_2m_min?.[i],
      rain_chance_pct: d.precipitation_probability_max?.[i],
    })),
    source: 'Open-Meteo',
  }
}

const WEATHER_DESCRIPTION = `Current weather and forecast for a place (Open-Meteo, live).

Use this for any weather question — web_search cannot answer them. If the user
names no place, leave \`place\` empty: it defaults to their home city
(${HOME_CITY}). For one figure put a \`stat\` blade up (e.g. "24°C"); for a
multi-day forecast a \`line\` chart of the highs works well.`

// ------------------------------------------------------------------ pictures

/**
 * Several pictures of a subject, for galleries and showcase walls. Serper's
 * Google Images when there is a key; otherwise Wikimedia Commons — free,
 * keyless, many photos per subject, at a 960px size Wikimedia actually serves
 * (arbitrary thumbnail sizes now answer 400).
 */
export async function imageSearch(q, n) {
  if (process.env.SERPER_API_KEY) {
    const d = await get('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: Math.min(20, n * 2) }),
    })
    return (d.images ?? [])
      .filter((i) => /^https:\/\//.test(i.imageUrl))
      .slice(0, n)
      .map((i) => ({ url: i.imageUrl, title: i.title, source: i.source }))
  }
  const ua = { headers: { 'User-Agent': 'ZEN-assistant/1.0 (local voice assistant)' } }
  const d = await get(
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6' +
      `&gsrlimit=${Math.min(20, n * 2)}&prop=imageinfo&iiprop=url|mime&iiurlwidth=960` +
      `&gsrsearch=${encodeURIComponent(`${q} filetype:bitmap`)}`,
    ua,
  )
  return Object.values(d.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ info: p.imageinfo?.[0], title: String(p.title ?? '').replace(/^File:|\.[a-z]+$/gi, '') }))
    .filter((x) => x.info && /image\/(jpeg|png|webp)/.test(x.info.mime ?? ''))
    .slice(0, n)
    .map((x) => ({ url: x.info.thumburl || x.info.url, title: x.title, source: 'Wikimedia Commons' }))
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
      tool(
        'image_search',
        'Find several pictures of a subject (a suit, car, building, place, person, product). Returns ' +
          'image URLs ready for a gallery or research_wall. Use 2-4 words, e.g. "Iron Man Mark VII armor".',
        { query: z.string(), count: z.number().int().min(1).max(10).optional().catch(undefined) },
        async ({ query, count }) => {
          try {
            const images = await imageSearch(String(query ?? '').trim(), count ?? 6)
            return {
              content: [{ type: 'text', text: images.length ? JSON.stringify({ images }, null, 1) : `No pictures found for "${query}".` }],
            }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Picture search failed: ${err?.message ?? err}` }] }
          }
        },
      ),
      tool(
        'weather',
        WEATHER_DESCRIPTION,
        {
          place: z.string().optional().catch(undefined).describe('City name. Empty = home city.'),
          days: z.number().int().min(1).max(7).optional().catch(undefined),
        },
        async (args) => {
          try {
            const w = await weather(args.place, args.days ?? 1)
            if (!w) return { isError: true, content: [{ type: 'text', text: `No place called "${args.place}" found.` }] }
            return { content: [{ type: 'text', text: JSON.stringify(w, null, 1) }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Weather failed: ${err?.message ?? err}` }] }
          }
        },
      ),
    ],
  })
}
