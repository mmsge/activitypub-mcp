import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { cacheKeyFor, isAllowedImageType, isAllowedImageHost } from './image-proxy.js'

/**
 * A bounded, least-recently-used disk cache for proxied images.
 *
 * On disk rather than in memory because the box has 3.7 GB of RAM shared by ~37
 * containers and images are the largest thing this app touches. Bounded because
 * the cache key comes from a public URL: unbounded, a crawler walking the archive
 * fills the disk, and on this box a full disk is an outage for every service on it.
 *
 * The bound is a *disk* budget (`STREAM_IMAGE_CACHE_MB`, 250 MB by default), swept
 * when it is exceeded rather than on every write. Eviction is by last access, so
 * the front page and recent months stay warm and a one-off crawl of 2016 does not
 * displace them permanently.
 */

const MAX_BYTES = () => config.STREAM_IMAGE_CACHE_MB * 1024 * 1024

/** Never hold a single image this large in memory, whatever the origin claims. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

/** Sweep down to this fraction of the budget, so a sweep is not needed every write. */
const SWEEP_TARGET = 0.8

export interface CachedImage {
  // A plain Uint8Array, not a Node Buffer: Hono's c.body() will not take a Buffer
  // (its ArrayBufferLike is not ArrayBuffer). Same reason as profile-assets.ts.
  body: Uint8Array<ArrayBuffer>
  contentType: string
  etag: string
}

interface Meta {
  contentType: string
  etag: string
}

let sweeping: Promise<void> | null = null

function dir(): string {
  return config.STREAM_IMAGE_CACHE_DIR
}

async function readCached(key: string): Promise<CachedImage | null> {
  try {
    const [body, metaRaw] = await Promise.all([
      readFile(join(dir(), `${key}.bin`)),
      readFile(join(dir(), `${key}.json`), 'utf8'),
    ])
    const meta = JSON.parse(metaRaw) as Meta
    // Re-checked on read, not trusted from disk: a cache written before the
    // allowlist tightened must not keep being served.
    if (!isAllowedImageType(meta.contentType)) return null
    return { body: new Uint8Array(body), contentType: meta.contentType, etag: meta.etag }
  } catch {
    return null
  }
}

async function writeCached(key: string, img: CachedImage): Promise<void> {
  await mkdir(dir(), { recursive: true })
  // Written to a temp name and renamed, so a crash mid-write cannot leave a
  // truncated image that then serves as a valid cache hit forever.
  const tmp = join(dir(), `${key}.${process.pid}.tmp`)
  await writeFile(tmp, img.body)
  await rename(tmp, join(dir(), `${key}.bin`))
  await writeFile(
    join(dir(), `${key}.json`),
    JSON.stringify({ contentType: img.contentType, etag: img.etag } satisfies Meta),
  )
}

/**
 * Evict least-recently-used entries until the cache is back under budget.
 *
 * Single-flight: a burst of misses must not start twenty concurrent sweeps all
 * stat-ing the same directory and racing each other's unlinks.
 *
 * The consequence of that, worth knowing before relying on it: awaiting `sweep()`
 * while one is already running joins the *running* one, which snapshotted the
 * directory before you called. So this is "a sweep has happened", not "the cache is
 * now under budget as of this instant". That is the right trade here — eviction is
 * housekeeping and the budget does not change at runtime — but it means a test
 * cannot lower the budget and await a sweep that is already in flight.
 */
export async function sweep(): Promise<void> {
  if (sweeping) return sweeping
  sweeping = (async () => {
    try {
      const names = await readdir(dir()).catch(() => [] as string[])
      const entries: Array<{ key: string; bytes: number; atime: number }> = []
      let total = 0
      for (const name of names) {
        if (!name.endsWith('.bin')) continue
        const key = name.slice(0, -4)
        try {
          const s = await stat(join(dir(), name))
          entries.push({ key, bytes: s.size, atime: s.atimeMs })
          total += s.size
        } catch { /* raced with another sweep; it is gone either way */ }
      }
      if (total <= MAX_BYTES()) return

      entries.sort((a, b) => a.atime - b.atime) // oldest access first
      const target = MAX_BYTES() * SWEEP_TARGET
      let removed = 0
      for (const e of entries) {
        if (total <= target) break
        await unlink(join(dir(), `${e.key}.bin`)).catch(() => {})
        await unlink(join(dir(), `${e.key}.json`)).catch(() => {})
        total -= e.bytes
        removed++
      }
      logger.info({ removed, remaining_bytes: total }, 'Image cache swept')
    } catch (e) {
      logger.warn({ error: e }, 'Image cache sweep failed')
    } finally {
      sweeping = null
    }
  })()
  return sweeping
}

/**
 * Where a redirect may send us, or null to stop.
 *
 * Pure, and separate from the fetch, because this is the decision that keeps the
 * proxy closed: `redirect: 'follow'` would happily chase a 302 from an allowed host
 * to any host at all, and the allowlist would stop meaning anything. Two rules:
 *
 *  - the target host must still be on the allowlist, and
 *  - it must still be https. An https image silently downgraded to http is a
 *    request we made in the clear on a reader's behalf.
 *
 * A relative Location is resolved against the current URL, as HTTP requires.
 */
export function redirectTarget(current: string, location: string | null): string | null {
  if (!location) return null
  let next: URL
  try {
    next = new URL(location, current)
  } catch {
    return null
  }
  if (next.protocol !== 'https:') return null
  if (!isAllowedImageHost(next.hostname)) return null
  if (next.href === current) return null // a self-redirect is a loop, not a hop
  return next.href
}

/**
 * Fetch an upstream image, following redirects by hand — see `redirectTarget` for
 * why by hand.
 */
async function fetchUpstream(url: string): Promise<CachedImage | null> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'image/*' },
    })

    if (res.status >= 300 && res.status < 400) {
      const next = redirectTarget(current, res.headers.get('location'))
      if (!next) {
        logger.warn(
          { from: current, to: res.headers.get('location') },
          'Image redirect refused: off the allowlist, downgraded to http, or a loop',
        )
        return null
      }
      current = next
      continue
    }

    if (!res.ok) return null
    const contentType = res.headers.get('content-type')
    if (!isAllowedImageType(contentType)) return null

    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null

    const body = new Uint8Array(await res.arrayBuffer())
    // Checked again after reading: content-length is the origin's claim, not a fact.
    if (body.length > MAX_IMAGE_BYTES) return null
    if (body.length === 0) return null

    return {
      body,
      contentType: contentType!.split(';')[0].trim().toLowerCase(),
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`,
    }
  }
  return null
}

/** In-flight fetches, so twenty readers of one page cause one upstream request. */
const inFlight = new Map<string, Promise<CachedImage | null>>()

/** The cached image for an upstream URL, fetching and storing it if absent. */
export async function getImage(url: string): Promise<CachedImage | null> {
  const key = cacheKeyFor(url)
  const hit = await readCached(key)
  if (hit) return hit

  const existing = inFlight.get(key)
  if (existing) return existing

  const work = (async () => {
    try {
      const img = await fetchUpstream(url)
      if (!img) return null
      await writeCached(key, img)
      // Not awaited: a reader waiting on housekeeping is a reader waiting for
      // nothing. A failed sweep is logged, never surfaced.
      void sweep()
      return img
    } catch (e) {
      logger.warn({ url, error: e }, 'Image proxy fetch failed')
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, work)
  return work
}
