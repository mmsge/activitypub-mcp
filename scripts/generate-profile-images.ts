/**
 * Generates the actor's avatar and header PNGs into src/assets/.
 *
 * Run with: npm run generate:profile-images
 *
 * Mastodon (and most fediverse software) only accepts raster avatars — SVG is
 * rejected by the media validator, so the profile images have to ship as PNG.
 * Rather than committing opaque binaries, the artwork is defined here as signed
 * distance fields and rasterised with node's built-in zlib. No dependencies, and
 * the images can be regenerated verbatim after a palette or shape tweak.
 *
 * Palette is the "Bolk" deep-forest-green/lime theme used across Markus' other
 * published material, so the actor looks related to the rest of it.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

type RGB = [number, number, number]

const GREEN: RGB = [0x14, 0x35, 0x21] // deep forest green — page background
const GREEN_DEEP: RGB = [0x0f, 0x2a, 0x1a] // gradient foot
const GREEN_PANEL: RGB = [0x1c, 0x4a, 0x2d] // faint watermark
const LIME: RGB = [0x9f, 0xe8, 0x22] // accent

/** Signed distance to a rounded box centred at (cx, cy) with half-extents
 *  (hx, hy) and corner radius r. Negative inside, positive outside. */
function sdRoundedBox(
  px: number, py: number,
  cx: number, cy: number,
  hx: number, hy: number,
  r: number,
): number {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

/** Antialiased coverage in [0, 1] for a distance field, with a one-pixel ramp. */
function coverage(sd: number): number {
  return Math.min(Math.max(0.5 - sd, 0), 1)
}

/** Coverage of a stroked (outlined) rounded box of the given thickness. */
function strokeCoverage(sd: number, thickness: number): number {
  return coverage(Math.abs(sd + thickness / 2) - thickness / 2)
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** Minimal RGB8 PNG encoder: one IHDR, one deflated IDAT, one IEND. */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  // 10-12: compression, filter, interlace — all zero

  // Prefix every scanline with filter type 0 (none).
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const src = y * width * 3
    const dst = y * (1 + width * 3)
    raw[dst] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + src, width * 3).copy(raw, dst + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Renders an image by evaluating `shade` at every pixel centre. */
function render(width: number, height: number, shade: (x: number, y: number) => RGB): Buffer {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade(x + 0.5, y + 0.5)
      const i = (y * width + x) * 3
      rgb[i] = r
      rgb[i + 1] = g
      rgb[i + 2] = b
    }
  }
  return encodePng(width, height, rgb)
}

/**
 * The mark: an archive box — a lid, an outlined body and a handle. It reads as
 * "this account files things away", which is the whole job. Drawn from a
 * normalised 512-unit grid so the avatar and the header watermark share it.
 *
 * Returns ink coverage in [0, 1] at the given point, `s` scaling the glyph.
 */
function archiveGlyph(px: number, py: number, cx: number, cy: number, s: number): number {
  const x = (px - cx) / s
  const y = (py - cy) / s
  const aa = 1 / s // keep the antialias ramp one output pixel wide

  const lid = coverage(sdRoundedBox(x, y, 0, -74, 112, 27, 13) / aa)
  const body = strokeCoverage(sdRoundedBox(x, y, 0, 38, 92, 66, 18) / aa, 19 / aa)
  const handle = coverage(sdRoundedBox(x, y, 0, 30, 33, 9, 9) / aa)

  return Math.min(1, lid + body + handle)
}

const width = 512
const avatar = render(width, width, (x, y) => {
  // Full-bleed background: the avatar is cropped to a circle or a rounded square
  // depending on the client, so nothing may depend on the corners surviving.
  const ink = archiveGlyph(x, y, 256, 256, 1)
  return mix(GREEN, LIME, ink)
})

const headerW = 1500
const headerH = 500 // 3:1, the ratio Mastodon crops headers to
const header = render(headerW, headerH, (x, y) => {
  let c = mix(GREEN, GREEN_DEEP, y / headerH)

  // Oversized glyph bleeding off the right edge, barely lighter than the ground.
  c = mix(c, GREEN_PANEL, archiveGlyph(x, y, 1230, 250, 1.55))

  // Lime rule along the bottom edge ties it to the carousel deck styling.
  c = mix(c, LIME, coverage(sdRoundedBox(x, y, headerW / 2, headerH - 4, headerW, 5, 0)))

  return c
})

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'avatar.png'), avatar)
writeFileSync(join(outDir, 'header.png'), header)
console.log(`avatar.png  ${width}x${width}  ${avatar.length} bytes`)
console.log(`header.png  ${headerW}x${headerH}  ${header.length} bytes`)
