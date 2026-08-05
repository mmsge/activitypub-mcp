import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = { SESSION_SECRET: 'x'.repeat(32), STREAM_IMAGE_CACHE_MB: 250 }
vi.mock('../config.js', () => ({ config: cfg }))

const {
  proxyPath, verifyProxyPath, isAllowedImageHost, isAllowedImageType,
  cacheKeyFor, resetImageProxyKey,
} = await import('./image-proxy.js')

beforeEach(() => {
  cfg.SESSION_SECRET = 'x'.repeat(32)
  cfg.STREAM_IMAGE_CACHE_MB = 250
  resetImageProxyKey()
})

const REAL = 'https://cdn.masto.host/skviplol/media_attachments/files/1.jpeg'

describe('isAllowedImageHost', () => {
  it('accepts the exact hosts', () => {
    for (const h of ['cdn.masto.host', 'skvip.lol', 'pixelfed.babb.no', 'loops.video',
      'bookwyrm.social', 'minreol.dk', 'rullen.no', 'lastfm.freetls.fastly.net']) {
      expect([h, isAllowedImageHost(h)]).toEqual([h, true])
    }
  })

  it('accepts a subdomain under a wildcard', () => {
    expect(isAllowedImageHost('bookwyrm-social.sfo3.digitaloceanspaces.com')).toBe(true)
    expect(isAllowedImageHost('media.loopsusercontent.com')).toBe(true)
  })

  it('does NOT let a wildcard become a suffix match', () => {
    // The failure this guards: `endsWith('digitaloceanspaces.com')` also accepts
    // `evildigitaloceanspaces.com`, which anyone can register, and the allowlist
    // stops being an allowlist.
    for (const h of [
      'evildigitaloceanspaces.com',
      'evil-digitaloceanspaces.com',
      'notloopsusercontent.com',
      'digitaloceanspaces.com.evil.example',
      'cdn.masto.host.evil.example',
      'evilrullen.no',
    ]) {
      expect([h, isAllowedImageHost(h)]).toEqual([h, false])
    }
  })

  it('rejects the bare wildcard domain and anything unlisted', () => {
    expect(isAllowedImageHost('digitaloceanspaces.com')).toBe(false)
    expect(isAllowedImageHost('example.com')).toBe(false)
    expect(isAllowedImageHost('')).toBe(false)
    expect(isAllowedImageHost('127.0.0.1')).toBe(false)
    expect(isAllowedImageHost('localhost')).toBe(false)
  })

  it('is case-insensitive, as hostnames are', () => {
    expect(isAllowedImageHost('CDN.Masto.Host')).toBe(true)
  })
})

describe('proxyPath', () => {
  it('mints a signed path for an allowed https URL', () => {
    const p = proxyPath(REAL)
    expect(p).toMatch(/^\/bilete\/[A-Za-z0-9_-]{27}\/[A-Za-z0-9_-]+$/)
  })

  it('round-trips back to the exact upstream URL', () => {
    const [, , sig, encoded] = proxyPath(REAL)!.split('/')
    expect(verifyProxyPath(sig, encoded)).toBe(REAL)
  })

  it('refuses anything it would not fetch', () => {
    for (const bad of [
      null, undefined, '', 'not a url', '/relative.png',
      'http://cdn.masto.host/a.jpg', // plaintext
      'https://example.com/a.jpg', // unlisted host
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'https://127.0.0.1/a.jpg',
    ]) {
      expect([String(bad), proxyPath(bad)]).toEqual([String(bad), null])
    }
  })

  it('is off when the cache budget is zero', () => {
    // The off-switch lives here so no view can forget it and emit a path the
    // route then refuses to serve.
    cfg.STREAM_IMAGE_CACHE_MB = 0
    expect(proxyPath(REAL)).toBeNull()
  })
})

describe('verifyProxyPath — the thing standing between this and an open proxy', () => {
  const enc = (u: string) => Buffer.from(u, 'utf8').toString('base64url')

  it('rejects a signature for a different URL', () => {
    const [, , sig] = proxyPath(REAL)!.split('/')
    expect(verifyProxyPath(sig, enc('https://cdn.masto.host/other.jpeg'))).toBeNull()
  })

  it('rejects an unsigned or wrong-length signature', () => {
    const [, , , encoded] = proxyPath(REAL)!.split('/')
    for (const sig of ['', 'x', 'x'.repeat(27), 'x'.repeat(64)]) {
      expect(verifyProxyPath(sig, encoded)).toBeNull()
    }
  })

  it('rejects a URL signed under a different key', () => {
    const p = proxyPath(REAL)!
    cfg.SESSION_SECRET = 'y'.repeat(32)
    resetImageProxyKey()
    const [, , sig, encoded] = p.split('/')
    expect(verifyProxyPath(sig, encoded)).toBeNull()
  })

  it('re-checks the host even for a validly signed URL', () => {
    // If the signing key ever leaked, a forged signature still must not point the
    // fetcher at a new host. So the allowlist is applied on the way out too.
    cfg.SESSION_SECRET = 'x'.repeat(32)
    resetImageProxyKey()
    const evil = 'https://example.com/a.jpg'
    // Sign it by hand, the way a key-holder would.
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const key = createHmac('sha256', cfg.SESSION_SECRET).update('meg:image-proxy:v1').digest()
    const sig = createHmac('sha256', key).update(evil).digest('base64url').slice(0, 27)
    // The signature itself is good — proven by a URL that only differs in host.
    const ok = 'https://cdn.masto.host/a.jpg'
    const okSig = createHmac('sha256', key).update(ok).digest('base64url').slice(0, 27)
    expect(verifyProxyPath(okSig, enc(ok))).toBe(ok)
    // …and the unlisted host is still refused.
    expect(verifyProxyPath(sig, enc(evil))).toBeNull()
  })

  it('survives garbage in the encoded segment without throwing', () => {
    for (const bad of ['', '!!!!', 'x'.repeat(5000), '%%%%']) {
      expect(() => verifyProxyPath('x'.repeat(27), bad)).not.toThrow()
      expect(verifyProxyPath('x'.repeat(27), bad)).toBeNull()
    }
  })
})

describe('isAllowedImageType', () => {
  it('accepts the raster formats the accounts actually serve', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) {
      expect([t, isAllowedImageType(t)]).toEqual([t, true])
    }
  })

  it('tolerates a charset parameter and odd casing', () => {
    expect(isAllowedImageType('IMAGE/JPEG; charset=binary')).toBe(true)
  })

  it('refuses SVG, which is a script container', () => {
    // Served from our own origin, an SVG runs script in our origin. Never.
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
  })

  it('refuses everything that is not an image', () => {
    for (const t of [null, '', 'text/html', 'application/octet-stream', 'video/mp4', 'image/*']) {
      expect([String(t), isAllowedImageType(t)]).toEqual([String(t), false])
    }
  })
})

describe('cacheKeyFor', () => {
  it('is a hex hash, so no upstream path reaches the filesystem', () => {
    expect(cacheKeyFor('https://cdn.masto.host/../../etc/passwd')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates URLs that differ at all', () => {
    expect(cacheKeyFor('https://a.example/1')).not.toBe(cacheKeyFor('https://a.example/2'))
  })
})
