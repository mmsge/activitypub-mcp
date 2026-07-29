import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

/** The profile images, read once at import. They are a few kilobytes each and
 *  never change at runtime, so keeping them in memory avoids per-request IO. */
function load(name: string): { body: Uint8Array<ArrayBuffer>; hash: string } {
  // Copied into a plain Uint8Array: Hono's body() will not take a Node Buffer,
  // whose backing store may be a SharedArrayBuffer.
  const body = new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url))),
  )
  return { body, hash: createHash('sha256').update(body).digest('hex').slice(0, 12) }
}

const assets = {
  avatar: load('avatar.png'),
  header: load('header.png'),
} as const

type AssetName = keyof typeof assets

/** Public URL for a profile image, carrying a content hash as a cache buster.
 *
 *  Mastodon only re-downloads a remote avatar when the URL *string* changes — it
 *  does not revalidate a URL it has already cached. Fingerprinting the URL means
 *  regenerating the artwork actually propagates to instances that already know us,
 *  while still letting us serve the bytes with a long max-age. */
export function getAssetUrl(name: AssetName): string {
  return `https://${config.APP_DOMAIN}/assets/${name}.png?v=${assets[name].hash}`
}

const app = new Hono()

for (const name of Object.keys(assets) as AssetName[]) {
  const { body, hash } = assets[name]
  app.get(`/${name}.png`, (c) => {
    // Immutable: the bytes for a given hash never change, and a request without the
    // hash is still safe to cache hard because the actor document always points at
    // the current fingerprint.
    if (c.req.header('if-none-match') === `"${hash}"`) return c.body(null, 304)
    return c.body(body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(body.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${hash}"`,
    })
  })
}

export { app as profileAssetsRouter }
