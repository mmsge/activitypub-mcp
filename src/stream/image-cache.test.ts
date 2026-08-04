import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = {
  SESSION_SECRET: 'x'.repeat(32),
  STREAM_IMAGE_CACHE_MB: 250,
  STREAM_IMAGE_CACHE_DIR: '',
}
vi.mock('../config.js', () => ({ config: cfg }))

// The allowlist is host-based and the test origin is 127.0.0.1, so it is stubbed —
// what is under test here is the fetch/cache/evict behaviour. The allowlist itself
// is covered in image-proxy.test.ts, including the redirect case below.
let hostAllowed: (h: string) => boolean = (h) => h === '127.0.0.1'
vi.mock('./image-proxy.js', async (orig) => {
  const real = await orig<typeof import('./image-proxy.js')>()
  return { ...real, isAllowedImageHost: (h: string) => hostAllowed(h) }
})

const { getImage, sweep, redirectTarget } = await import('./image-cache.js')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let server: Server
let base: string
let routes: Record<string, (res: import('node:http').ServerResponse) => void> = {}
let hits: Record<string, number> = {}

beforeEach(async () => {
  cfg.STREAM_IMAGE_CACHE_DIR = await mkdtemp(join(tmpdir(), 'imgcache-'))
  cfg.STREAM_IMAGE_CACHE_MB = 250
  hostAllowed = (h) => h === '127.0.0.1'
  hits = {}
  routes = {
    '/ok.png': (res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG) },
    '/svg': (res) => { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg/>') },
    '/html': (res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<b>no</b>') },
    '/404': (res) => { res.writeHead(404); res.end() },
    '/empty': (res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end() },
    '/huge': (res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) })
      res.end(PNG)
    },
    '/lying': (res) => {
      // No content-length at all (chunked), then an oversized body. The declared
      // length is a claim; this is the case where there is no claim to check and
      // only the post-read guard stands between us and 9 MB in memory.
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.alloc(9 * 1024 * 1024))
    },
  }
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      hits[path] = (hits[path] ?? 0) + 1
      const route = routes[path]
      if (route) return route(res)
      if (path.startsWith('/redirect-to/')) {
        res.writeHead(302, { location: decodeURIComponent(path.slice('/redirect-to/'.length)) })
        return res.end()
      }
      res.writeHead(404); res.end()
    }).listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(cfg.STREAM_IMAGE_CACHE_DIR, { recursive: true, force: true })
})

afterAll(() => { vi.restoreAllMocks() })

const cachedFiles = async () => (await readdir(cfg.STREAM_IMAGE_CACHE_DIR)).filter((f) => f.endsWith('.bin'))

describe('getImage', () => {
  it('fetches, returns and stores an image', async () => {
    const img = await getImage(`${base}/ok.png`)
    expect(img?.contentType).toBe('image/png')
    expect(img?.body.length).toBe(PNG.length)
    expect(img?.etag).toMatch(/^"[0-9a-f]{16}"$/)
    expect(await cachedFiles()).toHaveLength(1)
  })

  it('serves the second request from disk without touching the origin', async () => {
    await getImage(`${base}/ok.png`)
    const before = hits['/ok.png']
    const again = await getImage(`${base}/ok.png`)
    expect(again?.body.length).toBe(PNG.length)
    expect(hits['/ok.png']).toBe(before)
  })

  it('collapses concurrent misses into one upstream fetch', async () => {
    // Twenty readers of one page must not be twenty requests to someone's CDN.
    const all = await Promise.all(Array.from({ length: 20 }, () => getImage(`${base}/ok.png`)))
    expect(all.every((i) => i?.body.length === PNG.length)).toBe(true)
    expect(hits['/ok.png']).toBe(1)
  })

  it('refuses what it will not serve, and caches nothing', async () => {
    for (const path of ['/svg', '/html', '/404', '/empty', '/huge', '/lying', '/missing']) {
      expect([path, await getImage(`${base}${path}`)]).toEqual([path, null])
    }
    expect(await cachedFiles()).toHaveLength(0)
  })

  it('refuses a redirect rather than following it blindly', async () => {
    // The test origin is plaintext http, so every redirect here is refused as a
    // downgrade — which is itself the assertion worth making. Which targets are
    // *acceptable* is covered exhaustively by the redirectTarget tests below.
    const evil = 'https://example.com/a.png'
    expect(await getImage(`${base}/redirect-to/${encodeURIComponent(evil)}`)).toBeNull()
    expect(await getImage(`${base}/redirect-to/${encodeURIComponent(`${base}/ok.png`)}`)).toBeNull()
  })

  it('stops rather than looping on a redirect chain', async () => {
    const self = `${base}/loop`
    routes['/loop'] = (res) => { res.writeHead(302, { location: self }); res.end() }
    expect(await getImage(self)).toBeNull()
    expect(hits['/loop']).toBeLessThanOrEqual(4) // MAX_REDIRECTS + 1
  })

  it('does not leave a half-written file behind on a failed fetch', async () => {
    await getImage(`${base}/404`)
    expect(await readdir(cfg.STREAM_IMAGE_CACHE_DIR)).toHaveLength(0)
  })
})

describe('sweep — the disk bound', () => {
  // Files are placed directly rather than through getImage: getImage fires an
  // un-awaited sweep, and single-flight means a later `await sweep()` joins that
  // already-running one, which snapshotted atimes before this test aged anything.
  // (That cost a flaky run to find; see the note on sweep().)
  async function place(names: string[], bytes = 1024): Promise<void> {
    await mkdir(cfg.STREAM_IMAGE_CACHE_DIR, { recursive: true })
    for (const n of names) {
      await writeFile(join(cfg.STREAM_IMAGE_CACHE_DIR, `${n}.bin`), Buffer.alloc(bytes))
      await writeFile(join(cfg.STREAM_IMAGE_CACHE_DIR, `${n}.json`), '{"contentType":"image/png","etag":"x"}')
    }
  }

  it('evicts least-recently-accessed entries until back under budget', async () => {
    await place(['a', 'b', 'c', 'd'])
    expect(await cachedFiles()).toHaveLength(4)

    // Age two so their eviction order is unambiguous.
    const old = new Date(Date.now() - 86_400_000)
    for (const f of ['a.bin', 'b.bin']) await utimes(join(cfg.STREAM_IMAGE_CACHE_DIR, f), old, old)

    cfg.STREAM_IMAGE_CACHE_MB = 2 / 1024 // 2 KB against 4 KB on disk
    await sweep()

    const left = await cachedFiles()
    // Swept down to the 80% target and stopped — not emptied.
    expect(left).toEqual(['d.bin'])
  })

  it('triggers a sweep on its own after a miss, without being asked', async () => {
    await place(['old1', 'old2', 'old3', 'old4'])
    cfg.STREAM_IMAGE_CACHE_MB = 2 / 1024
    await getImage(`${base}/ok.png`)
    // The write fires sweep() without awaiting it; give it a turn to finish.
    await new Promise((r) => setTimeout(r, 50))
    expect((await cachedFiles()).length).toBeLessThan(5)
  })

  it('leaves the cache alone while it is under budget', async () => {
    await getImage(`${base}/ok.png`)
    await sweep()
    expect(await cachedFiles()).toHaveLength(1)
  })

  it('drops the .json alongside the .bin, so no orphan metadata accumulates', async () => {
    await getImage(`${base}/ok.png`)
    cfg.STREAM_IMAGE_CACHE_MB = 0.0000001
    await sweep()
    expect(await readdir(cfg.STREAM_IMAGE_CACHE_DIR)).toHaveLength(0)
  })

  it('tolerates a missing cache directory', async () => {
    await rm(cfg.STREAM_IMAGE_CACHE_DIR, { recursive: true, force: true })
    await expect(sweep()).resolves.toBeUndefined()
  })

  it('runs one sweep at a time under a burst', async () => {
    await getImage(`${base}/ok.png`)
    await Promise.all(Array.from({ length: 10 }, () => sweep()))
    expect((await stat(cfg.STREAM_IMAGE_CACHE_DIR)).isDirectory()).toBe(true)
  })
})

describe('redirectTarget — where a 302 may send us', () => {
  const HERE = 'https://cdn.masto.host/a.jpg'
  // The real allowlist, not the stub: this is the function that keeps the proxy
  // closed, so it is tested against the hosts production actually uses.
  beforeEach(() => {
    hostAllowed = (h) => ['cdn.masto.host', 'bookwyrm.social'].includes(h)
  })

  it('follows an https hop to another allowed host', () => {
    expect(redirectTarget(HERE, 'https://bookwyrm.social/b.jpg')).toBe('https://bookwyrm.social/b.jpg')
  })

  it('resolves a relative Location against the current URL', () => {
    expect(redirectTarget(HERE, '/b.jpg')).toBe('https://cdn.masto.host/b.jpg')
    expect(redirectTarget(HERE, 'b.jpg')).toBe('https://cdn.masto.host/b.jpg')
  })

  it('refuses a hop off the allowlist', () => {
    // Without this the proxy is open to any host an allowed one will 302 towards.
    expect(redirectTarget(HERE, 'https://example.com/b.jpg')).toBeNull()
    expect(redirectTarget(HERE, 'https://169.254.169.254/latest/meta-data/')).toBeNull()
  })

  it('refuses a downgrade to http, and any other scheme', () => {
    for (const to of [
      'http://cdn.masto.host/b.jpg',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'ftp://cdn.masto.host/b.jpg',
    ]) {
      expect([to, redirectTarget(HERE, to)]).toEqual([to, null])
    }
  })

  it('refuses a self-redirect and a missing or unparseable Location', () => {
    expect(redirectTarget(HERE, HERE)).toBeNull()
    expect(redirectTarget(HERE, null)).toBeNull()
    expect(redirectTarget(HERE, '')).toBeNull()
    expect(redirectTarget(HERE, 'http://[')).toBeNull()
  })
})
