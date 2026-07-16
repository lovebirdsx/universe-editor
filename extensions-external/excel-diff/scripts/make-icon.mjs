/*
 * Generates icon.png for the Excel Viewer & Diff extension without any native
 * image dependency: it rasterizes a spreadsheet glyph into an RGBA buffer and
 * hand-encodes a PNG (IHDR + zlib-deflated IDAT + IEND with CRC32). Run with
 * `node scripts/make-icon.mjs` after tweaking the drawing below.
 *
 * The glyph is a rounded green sheet (Excel's brand green) with white grid
 * cells; two cells are tinted add-green / delete-red to convey the "diff" half
 * of the extension, distinguishing it from a plain spreadsheet icon.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 256
const buf = new Uint8Array(SIZE * SIZE * 4) // RGBA, transparent by default

const px = (x, y, [r, g, b, a = 255]) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  // Simple src-over onto whatever is there (background painted first).
  const sa = a / 255
  const da = buf[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa)
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa)
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa)
  buf[i + 3] = Math.round(oa * 255)
}

// Rounded-rectangle test.
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

const GREEN = [33, 115, 70] // #217346 Excel green
const WHITE = [255, 255, 255]
const ADD = [198, 239, 206] // soft green cell
const DEL = [255, 199, 206] // soft red cell

// 1) Rounded green sheet.
const M = 34 // margin
const R = 40 // corner radius
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inRoundRect(x, y, M, M, SIZE - M, SIZE - M, R)) {
      px(x, y, GREEN)
    }
  }
}

// 2) White grid: 4 columns x 4 rows inside an inner padding.
const gx0 = M + 22
const gy0 = M + 20
const gx1 = SIZE - M - 22
const gy1 = SIZE - M - 20
const COLS = 4
const ROWS = 4
const cellW = (gx1 - gx0) / COLS
const cellH = (gy1 - gy0) / ROWS
const LINE = 6 // grid gap (green shows through)

const cellColor = (c, r) => {
  if (c === 3 && r === 1) return ADD
  if (c === 1 && r === 2) return DEL
  return WHITE
}

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const x0 = Math.round(gx0 + c * cellW) + LINE / 2
    const y0 = Math.round(gy0 + r * cellH) + LINE / 2
    const x1 = Math.round(gx0 + (c + 1) * cellW) - LINE / 2
    const y1 = Math.round(gy0 + (r + 1) * cellH) - LINE / 2
    const color = cellColor(c, r)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, color)
  }
}

// --- PNG encoding (truecolor + alpha, 8-bit) ---
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// Prepend a filter byte (0 = none) to each scanline.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  buf.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v
  })
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
