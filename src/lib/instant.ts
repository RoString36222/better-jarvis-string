/**
 * Answers that need no model: arithmetic, the time, the date, unit
 * conversions. Worked out here in a few milliseconds instead of a ~1s round
 * trip to the gateway, so the questions people ask most casually are the ones
 * that come back fastest.
 *
 * Deliberately narrow. Every pattern is anchored to the WHOLE utterance, so
 * "what's 15% of the market Meta holds" is not arithmetic and goes to the model
 * as before. Returns null for anything it is not certain about.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const SCALES: [number, string][] = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
]

function under1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`)
    n %= 100
    if (n) parts.push('and')
  }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''))
  else if (n || !parts.length) parts.push(ONES[n])
  return parts.join(' ')
}

/** 1234.5 -> "one thousand two hundred and thirty-four point five". */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) return 'an undefined number'
  if (value < 0) return `minus ${numberToWords(-value)}`
  // Two decimals is all anyone wants read aloud.
  const rounded = Math.round(value * 100) / 100
  let whole = Math.floor(rounded)
  const frac = Math.round((rounded - whole) * 100)
  if (whole >= 1e15) return rounded.toExponential(2)
  const parts: string[] = []
  for (const [size, name] of SCALES) {
    if (whole >= size) {
      parts.push(`${under1000(Math.floor(whole / size))} ${name}`)
      whole %= size
    }
  }
  if (whole || !parts.length) parts.push(under1000(whole))
  let out = parts.join(' ')
  if (frac) {
    const digits = String(frac).padStart(2, '0').replace(/0$/, '')
    out += ' point ' + [...digits].map((d) => ONES[Number(d)]).join(' ')
  }
  return out
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const NUM = String.raw`(-?\d[\d,]*(?:\.\d+)?)`
const num = (s: string) => Number(s.replace(/,/g, ''))

/** Strips the wake word, polite openers and trailing punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\W*(?:hey|hi|ok|okay|yo)?\s*(?:zen|string|jarvis)\b[\s,.:!?-]*/, '')
    .replace(/^(?:please|so|um|uh)\s+/, '')
    .replace(/^(?:what'?s|what is|how much is|calculate|compute|work out|tell me)\s+/, '')
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ------------------------------------------------------------------ arithmetic

const OPS: [RegExp, (a: number, b: number) => number][] = [
  [/^(?:\+|plus|add)$/, (a, b) => a + b],
  [/^(?:-|−|minus|less)$/, (a, b) => a - b],
  [/^(?:\*|x|×|times|multiplied by)$/, (a, b) => a * b],
  [/^(?:\/|÷|divided by|over)$/, (a, b) => a / b],
  [/^(?:to the power of|raised to)$/, (a, b) => a ** b],
]

function arithmetic(q: string): number | null {
  let m = q.match(new RegExp(`^${NUM}\\s*(?:%|percent|per cent)\\s+of\\s+${NUM}$`))
  if (m) return (num(m[1]) / 100) * num(m[2])

  m = q.match(new RegExp(`^(?:the )?square root of ${NUM}$`))
  if (m && num(m[1]) >= 0) return Math.sqrt(num(m[1]))

  m = q.match(new RegExp(`^${NUM}\\s+(squared|cubed)$`))
  if (m) return num(m[1]) ** (m[2] === 'squared' ? 2 : 3)

  m = q.match(new RegExp(`^${NUM}\\s*(\\+|-|−|\\*|x|×|\\/|÷|plus|add|minus|less|times|multiplied by|divided by|over|to the power of|raised to)\\s*${NUM}$`))
  if (m) {
    const op = OPS.find(([re]) => re.test(m![2]))
    if (op) return op[1](num(m[1]), num(m[3]))
  }
  return null
}

// ----------------------------------------------------------------- conversions

type Unit = { names: RegExp; kind: string; toBase: (v: number) => number; fromBase: (v: number) => number; say: string }
const linear = (names: RegExp, kind: string, factor: number, say: string): Unit => ({
  names, kind, say, toBase: (v) => v * factor, fromBase: (v) => v / factor,
})
const UNITS: Unit[] = [
  linear(/^(?:km|kms|kilometres?|kilometers?)$/, 'length', 1000, 'kilometres'),
  linear(/^(?:m|metres?|meters?)$/, 'length', 1, 'metres'),
  linear(/^(?:cm|centimetres?|centimeters?)$/, 'length', 0.01, 'centimetres'),
  linear(/^(?:mi|miles?)$/, 'length', 1609.344, 'miles'),
  linear(/^(?:ft|feet|foot)$/, 'length', 0.3048, 'feet'),
  linear(/^(?:in|inch|inches)$/, 'length', 0.0254, 'inches'),
  linear(/^(?:kg|kgs|kilos?|kilograms?)$/, 'mass', 1, 'kilograms'),
  linear(/^(?:g|grams?)$/, 'mass', 0.001, 'grams'),
  linear(/^(?:lb|lbs|pounds?)$/, 'mass', 0.45359237, 'pounds'),
  linear(/^(?:l|litres?|liters?)$/, 'volume', 1, 'litres'),
  linear(/^(?:gallons?|gal)$/, 'volume', 3.785411784, 'US gallons'),
  {
    names: /^(?:°?c|celsius|centigrade|degrees? celsius)$/, kind: 'temp', say: 'degrees Celsius',
    toBase: (v) => v, fromBase: (v) => v,
  },
  {
    names: /^(?:°?f|fahrenheit|degrees? fahrenheit)$/, kind: 'temp', say: 'degrees Fahrenheit',
    toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32,
  },
]
const unit = (s: string) => UNITS.find((u) => u.names.test(s.trim()))

function conversion(q: string): string | null {
  const m = q
    .replace(/^convert\s+/, '')
    .match(new RegExp(`^${NUM}\\s*([a-z° ]+?)\\s+(?:to|in|into|as)\\s+([a-z° ]+)$`))
  if (!m) return null
  const from = unit(m[2])
  const to = unit(m[3])
  if (!from || !to || from.kind !== to.kind || from === to) return null
  const value = to.fromBase(from.toBase(num(m[1])))
  return `${cap(numberToWords(num(m[1])))} ${from.say} is ${numberToWords(value)} ${to.say}, sir.`
}

// ----------------------------------------------------------------- time, date

function clock(now: Date): string {
  const h = now.getHours() % 12 || 12
  const m = now.getMinutes()
  const mins = m === 0 ? "o'clock" : m < 10 ? `oh ${ONES[m]}` : numberToWords(m)
  return `${numberToWords(h)} ${mins} ${now.getHours() < 12 ? 'in the morning' : now.getHours() < 17 ? 'in the afternoon' : 'in the evening'}`
}

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth',
  'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth',
  'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first']

function timeOrDate(q: string, now: Date): string | null {
  if (/^(?:the )?time(?: now| right now)?$|^what time is it(?: now| right now)?$|^(?:do you have|got) the time$/.test(q)) {
    return `It's ${clock(now)}, sir.`
  }
  if (/^(?:the |today'?s )?date(?: today)?$|^what day is (?:it|today)$|^today$|^what(?:'?s| is) today'?s date$/.test(q)) {
    const day = now.toLocaleDateString('en-GB', { weekday: 'long' })
    const month = now.toLocaleDateString('en-GB', { month: 'long' })
    return `${day}, the ${ORD[now.getDate()]} of ${month}, sir.`
  }
  return null
}

// --------------------------------------------------------------------- entry

/** A spoken answer, or null to hand the question to the model. */
export function instantAnswer(text: string, now: Date = new Date()): string | null {
  const q = normalise(text)
  if (!q || q.length > 60) return null
  const t = timeOrDate(q, now)
  if (t) return t
  const c = conversion(q)
  if (c) return c
  const a = arithmetic(q)
  if (a !== null && Number.isFinite(a)) return `${cap(numberToWords(a))}, sir.`
  return null
}
