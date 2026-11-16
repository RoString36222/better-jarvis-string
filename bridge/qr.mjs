/**
 * A small QR code encoder, so ZEN can put a link on screen for the phone's
 * camera without a dependency for one picture.
 *
 * Byte mode only, error correction L or M, any version that fits. It follows
 * the standard (ISO 18004) step by step, the same way Project Nayuki's
 * reference encoder does: data bits → Reed–Solomon blocks → interleave →
 * place around the fixed patterns → try all eight masks, keep the one the
 * standard's penalty rules like best.
 *
 * qrSvg(text) returns an SVG string; qrDataUrl(text) the same as a data: URL
 * an <img> can show (the HUD's sanitiser allows data:image/).
 */

// Error-correction codewords per block and block counts, by version (index 0 unused).
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
}
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
}
const FORMAT_BITS = { L: 1, M: 0 }

/** Modules left for data after the fixed patterns, for a version. */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}
const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver]

// ------------------------------------------------------------ Reed–Solomon

function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0)
  r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root)
      if (j + 1 < r.length) r[j] ^= r[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return r
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ r.shift()
    r.push(0)
    divisor.forEach((d, i) => (r[i] ^= gfMul(d, factor)))
  }
  return r
}

// ------------------------------------------------------------------ build

/** @returns {boolean[][]} modules[y][x], true = dark */
export function qrMatrix(text, ecl = 'L') {
  const bytes = [...new TextEncoder().encode(String(text))]
  let ver = 1
  for (; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break
  }
  if (ver > 40) throw new Error('Too long for a QR code.')

  // Bits: mode 0100 (byte), length, the bytes, terminator, pad.
  const bits = []
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  put(4, 4)
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const capacity = dataCodewords(ver, ecl) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Split into blocks, add error correction, interleave.
  const nBlocks = BLOCKS[ecl][ver]
  const eccLen = ECC_PER_BLOCK[ecl][ver]
  const raw = Math.floor(rawModules(ver) / 8)
  const nShort = nBlocks - (raw % nBlocks)
  const shortLen = Math.floor(raw / nBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < nShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const codewords = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= nShort) codewords.push(b[i])
    })
  }

  const size = ver * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => {
    mod[y][x] = dark
    fixed[y][x] = true
  }

  // Timing lines, finders (with their white separators), alignment patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
      }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
    const pos = [6]
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
  }

  const drawFormat = (mask) => {
    const d = (FORMAT_BITS[ecl] << 3) | mask
    let rem = d
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const b = ((d << 10) | rem) ^ 0x5412
    const bit = (i) => ((b >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0) // reserves the area; drawn for real once the mask is chosen
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const b = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const c = Math.floor(i / 3)
      set(a, c, dark)
      set(c, a, dark)
    }
  }

  // Data, in the zigzag from the bottom-right corner, two columns at a time.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v
        if (!fixed[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]
  }

  let best = 0
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    applyMask(m)
    drawFormat(m)
    const s = penalty(mod)
    if (s < bestScore) {
      best = m
      bestScore = s
    }
    applyMask(m) // undo (XOR)
  }
  applyMask(best)
  drawFormat(best)
  return mod
}

/** The standard's four penalty rules (runs, 2×2 blocks, finder look-alikes, balance). */
function penalty(m) {
  const n = m.length
  let score = 0
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1
      const row = []
      for (let b = 0; b < n; b++) row.push(get(a, b))
      for (let b = 1; b <= n; b++) {
        if (b < n && row[b] === row[b - 1]) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      const s = row.map((d) => (d ? 1 : 0)).join('')
      score += 40 * ((s.match(/(?=1011101(0000))/g) || []).length + (s.match(/(?=(0000)1011101)/g) || []).length)
    }
  }
  line((a, b) => m[a][b])
  line((a, b) => m[b][a])
  let dark = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++
      if (y < n - 1 && x < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3
    }
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10
  return score
}

/** Black on white with the standard four-module quiet zone, as SVG. */
export function qrSvg(text, { ecl = 'L', scale = 8 } = {}) {
  const m = qrMatrix(text, ecl)
  const q = 4
  const w = m.length + q * 2
  let path = ''
  m.forEach((row, y) => row.forEach((d, x) => d && (path += `M${x + q} ${y + q}h1v1h-1z`)))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${w * scale}" height="${w * scale}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  )
}

export const qrDataUrl = (text, o) => `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, o)).toString('base64')}`
