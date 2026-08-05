import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * Serving the stream's images from meg.msge.no instead of hotlinking them.
 *
 * Two reasons, one of which is the honest one.
 *
 * The page claims to be self-contained. Hotlinked it is not: reading it makes a
 * request to seven CDNs, which is a fact about the reader that the page's own
 * privacy claim cannot account for, and it forces a CSP that names those seven
 * hosts — no statement at all compared to `img-src 'self' data:`.
 *
 * The other reason is durability. The archive goes back to 2016 and origin CDNs
 * rotate: a Pixelfed or Loops URL that 404s takes the image with it, and the
 * archive is then wrong about what was posted.
 *
 * What this is not: a resizer. No decoding, no re-encoding, no thumbnails. The box
 * is a CAX11 with two vCPUs shared by ~37 containers, and image processing there is
 * a way to make the whole box unresponsive. Bytes in, same bytes out.
 *
 * Three things keep it from being an open proxy — which is the failure mode that
 * matters, because an open image proxy is someone else's bandwidth bill and
 * someone else's abuse report:
 *
 *  1. **Signed URLs.** The path carries an HMAC of the upstream URL. A URL this app
 *     did not mint does not resolve. There is no way to ask for an arbitrary host.
 *  2. **A host allowlist**, checked again at fetch time and after every redirect.
 *     The signature says "we minted this"; the allowlist says "and it is still a
 *     host we are willing to fetch from" even if the signing key ever leaked.
 *  3. **A bounded disk cache** with LRU eviction, so a crawl cannot fill the disk.
 */

/**
 * Hosts the proxy will fetch from — the origin CDNs of Markus' six accounts, plus
 * Last.fm's.
 *
 * This list must stay in step with `img-src` in the meg.msge.no Caddy block over in
 * naustet-server. Until the CSP is tightened to `'self'`, both are load-bearing:
 * the CSP stops the browser fetching elsewhere, this stops the server doing it.
 *
 * A leading `*.` matches exactly one or more labels below the domain, never the
 * bare domain and never a suffix match — `evil-digitaloceanspaces.com` must not
 * pass, which a naive `endsWith` would allow.
 */
export const IMAGE_HOSTS: readonly string[] = [
  'cdn.masto.host',
  'skvip.lol',
  'pixelfed.babb.no',
  'loops.video',
  '*.loopsusercontent.com',
  'bookwyrm.social',
  '*.digitaloceanspaces.com',
  'minreol.dk',
  // Rullen serves its clip posters from its own origin (MEDIA_FORCE_PROXY), not from
  // the object-storage bucket its .env.example points at.
  'rullen.no',
  'lastfm.freetls.fastly.net',
  '*.lastfm.freetls.fastly.net',
]

export function isAllowedImageHost(host: string): boolean {
  const h = host.toLowerCase()
  for (const pattern of IMAGE_HOSTS) {
    if (!pattern.startsWith('*.')) {
      if (h === pattern) return true
      continue
    }
    const suffix = pattern.slice(1) // ".example.com" — the dot is what stops
    if (h.endsWith(suffix) && h.length > suffix.length) return true // "evilexample.com"
  }
  return false
}

/**
 * The signing key, derived from SESSION_SECRET rather than used directly.
 *
 * Separate keys for separate purposes: an admin session cookie and a public image
 * URL should not be signed by the same secret, so that a weakness in one cannot be
 * turned into forgeries of the other.
 */
let cachedKey: Buffer | null = null
function signingKey(): Buffer {
  if (!cachedKey) {
    cachedKey = createHmac('sha256', config.SESSION_SECRET).update('meg:image-proxy:v1').digest()
  }
  return cachedKey
}

/** Test seam — SESSION_SECRET does not change at runtime in production. */
export function resetImageProxyKey(): void {
  cachedKey = null
}

function sign(url: string): string {
  return createHmac('sha256', signingKey()).update(url).digest('base64url').slice(0, 27)
}

/**
 * The proxy path for an upstream image, or null if we will not serve it.
 *
 * Returning null rather than throwing: a single odd attachment must degrade to "no
 * image" and not take down the page it is on.
 */
export function proxyPath(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  // The off-switch, checked here rather than at each call site so no view can
  // forget it and emit a proxy path that the route then refuses to serve.
  if (config.STREAM_IMAGE_CACHE_MB === 0) return null
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (!isAllowedImageHost(u.hostname)) return null
  try {
    // The URL travels in the path, not a query string, so a cache or a log that
    // treats query strings as noise cannot lose it.
    return `/bilete/${sign(u.href)}/${Buffer.from(u.href, 'utf8').toString('base64url')}`
  } catch {
    // Config validation makes an unusable signing key impossible in production, but
    // a view that throws takes the whole page with it. Degrade to hotlinking.
    return null
  }
}

/** Recover and re-verify the upstream URL from a proxy path, or null. */
export function verifyProxyPath(sig: string, encoded: string): string | null {
  let url: string
  try {
    url = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = sign(url)
  // Constant-time, and length-checked first — timingSafeEqual throws on a length
  // mismatch, which would itself be a 500 rather than a 404.
  if (sig.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  // Checked again after verifying, not only at signing time. If the key ever
  // leaked, a forged signature still could not point the fetcher at a new host.
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !isAllowedImageHost(u.hostname)) return null
  return u.href
}

/** The on-disk name for a cached image: a hash, so no upstream path reaches the FS. */
export function cacheKeyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** Image types we will pass through. No SVG — it is a script container. */
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]

export function isAllowedImageType(contentType: string | null): boolean {
  if (!contentType) return false
  return ALLOWED_IMAGE_TYPES.includes(contentType.split(';')[0].trim().toLowerCase())
}
