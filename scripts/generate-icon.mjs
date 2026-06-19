import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconSizes = [16, 32, 48, 64, 128, 256]

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rawRow = y * (stride + 1)
    raw[rawRow] = 0
    rgba.copy(raw, rawRow + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function roundedRectContains(x, y, size, inset, radius) {
  const min = inset
  const max = size - inset - 1
  const cx = x < min + radius ? min + radius : x > max - radius ? max - radius : x
  const cy = y < min + radius ? min + radius : y > max - radius ? max - radius : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function setPixel(buffer, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return
  }
  const offset = (y * size + x) * 4
  buffer[offset] = color[0]
  buffer[offset + 1] = color[1]
  buffer[offset + 2] = color[2]
  buffer[offset + 3] = color[3]
}

function blend(a, b, factor) {
  return Math.round(a + (b - a) * factor)
}

function drawText(buffer, size) {
  const letters = [
    ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  ]
  const scale = Math.max(1, Math.floor(size / 18))
  const gap = Math.max(1, scale)
  const letterWidth = letters[0][0].length * scale
  const textWidth = letterWidth * 2 + gap
  const textHeight = letters[0].length * scale
  const startX = Math.floor((size - textWidth) / 2)
  const startY = Math.floor(size * 0.42)
  const colors = [
    [244, 248, 251, 255],
    [159, 240, 255, 255],
  ]

  letters.forEach((letter, letterIndex) => {
    const letterX = startX + letterIndex * (letterWidth + gap)
    letter.forEach((row, rowIndex) => {
      ;[...row].forEach((pixel, columnIndex) => {
        if (pixel !== '1') {
          return
        }
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            setPixel(
              buffer,
              size,
              letterX + columnIndex * scale + x,
              startY + rowIndex * scale + y,
              colors[letterIndex],
            )
          }
        }
      })
    })
  })
}

function drawGaugeArc(buffer, size) {
  const cx = size / 2
  const cy = size * 0.58
  const radius = size * 0.33
  const thickness = Math.max(1.4, size * 0.035)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI
      const normalized = angle < 0 ? angle + 360 : angle
      const inArc =
        distance >= radius - thickness &&
        distance <= radius + thickness &&
        normalized >= 195 &&
        normalized <= 345

      if (inArc) {
        const factor = (normalized - 195) / 150
        setPixel(buffer, size, x, y, [
          blend(55, 255, factor),
          blend(214, 179, factor),
          blend(255, 63, factor),
          255,
        ])
      }
    }
  }
}

function drawIcon(size) {
  const buffer = Buffer.alloc(size * size * 4)
  const inset = Math.max(1, Math.floor(size * 0.055))
  const border = Math.max(1, Math.floor(size * 0.045))
  const radius = Math.max(3, Math.floor(size * 0.16))

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = roundedRectContains(x, y, size, inset, radius)
      if (!inside) {
        continue
      }

      const inner = roundedRectContains(x, y, size, inset + border, radius - border)
      const vertical = y / Math.max(1, size - 1)
      const base = [
        blend(17, 8, vertical),
        blend(26, 13, vertical),
        blend(34, 18, vertical),
        255,
      ]
      setPixel(buffer, size, x, y, inner ? base : [55, 214, 255, 255])
    }
  }

  drawGaugeArc(buffer, size)
  drawText(buffer, size)
  return encodePng(size, size, buffer)
}

function createIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const directory = entries.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })

  return Buffer.concat([
    header,
    ...directory,
    ...entries.map((entry) => entry.png),
  ])
}

await mkdir(path.join(repoRoot, 'build'), { recursive: true })
await mkdir(path.join(repoRoot, 'public'), { recursive: true })

const pngEntries = iconSizes.map((size) => ({ size, png: drawIcon(size) }))
const largestPng = pngEntries.at(-1).png

await writeFile(path.join(repoRoot, 'build', 'icon.ico'), createIco(pngEntries))
await writeFile(path.join(repoRoot, 'build', 'icon.png'), largestPng)
await writeFile(path.join(repoRoot, 'public', 'icon.png'), largestPng)

console.log('Generated build/icon.ico, build/icon.png, and public/icon.png')
