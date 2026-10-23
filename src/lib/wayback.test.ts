import { describe, it, expect } from 'vitest'
import { WaybackClient, parseCdx, sniffImage, type FetchLike } from './wayback.js'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])
const LINK = { host: 'twitpic' as const, id: '517yh', url: 'https://twitpic.com/517yh' }

type Route = { status?: number; body?: string | Uint8Array; headers?: Record<string, string> }

/** A fake archive.org: the first route whose key the URL contains answers. */
function fakeFetch(routes: Array<[string, Route | (() => Route)]>) {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    calls.push(url)
    const hit = routes.find(([k]) => url.includes(k))
    const r = hit ? (typeof hit[1] === 'function' ? hit[1]() : hit[1]) : { status: 404, body: '' }
    const status = r.status ?? 200
    const body = r.body ?? ''
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body).buffer as ArrayBuffer,
      text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
    }
  }
  return { fetch, calls }
}

const cdx = (...rows: Array<[string, string, string]>) =>
  JSON.stringify([['timestamp', 'original', 'mimetype'], ...rows])
const noDelay = { sleep: async () => {}, delayMs: 0 }

describe('parseCdx', () => {
  it('reads rows by header name and tolerates an empty answer', () => {
    expect(parseCdx(cdx(['20100101000000', 'http://twitpic.com/x', 'text/html']))).toEqual([
      { timestamp: '20100101000000', original: 'http://twitpic.com/x', mimetype: 'text/html' },
    ])
    expect(parseCdx('')).toEqual([])
    expect(parseCdx('[]')).toEqual([])
  })
})

describe('sniffImage', () => {
  it('knows an image by its first bytes, not its label', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('<html>not found</html>'))).toBeNull()
  })
})

describe('WaybackClient.recover', () => {
  it('returns the image straight from a direct image capture', async () => {
    const { fetch } = fakeFetch([
      ['cdx/search/cdx?url=twitpic.com%2Fshow%2Ffull%2F517yh', { body: cdx(['20120101000000', 'http://twitpic.com/show/full/517yh', 'image/jpeg']) }],
      ['web/20120101000000id_/http://twitpic.com/show/full/517yh', { body: JPEG }],
    ])
    const r = await new WaybackClient({ fetch, ...noDelay }).recover(LINK)
    expect(r.status).toBe('found')
    if (r.status === 'found') {
      expect(r.contentType).toBe('image/jpeg')
      expect(r.via).toBe('twitpic.com/show/full/517yh')
    }
  })

  it('finds the image through the photo page when no image URL was captured', async () => {
    const { fetch } = fakeFetch([
      ['cdx/search/cdx?url=twitpic.com%2F517yh', { body: cdx(['20100512000000', 'http://twitpic.com/517yh', 'text/html']) }],
      ['web/20100512000000id_/http://twitpic.com/517yh', { body: '<img id="photo-display" src="http://web1.twitpic.com/img/1.jpg">' }],
      ['cdx/search/cdx?url=http%3A%2F%2Fweb1.twitpic.com', { body: '' }],
      ['web/20100512000000id_/http://web1.twitpic.com/img/1.jpg', { body: JPEG }],
      ['cdx/search/cdx', { body: '' }],
    ])
    const r = await new WaybackClient({ fetch, ...noDelay }).recover(LINK)
    expect(r.status).toBe('found')
  })

  it('does not save an HTML error page served under an image capture', async () => {
    const { fetch } = fakeFetch([
      ['cdx/search/cdx?url=twitpic.com%2Fshow%2Ffull', { body: cdx(['20120101000000', 'http://twitpic.com/show/full/517yh', 'image/jpeg']) }],
      ['id_/http://twitpic.com/show/full/517yh', { body: '<html>Wayback error</html>' }],
      ['cdx/search/cdx', { body: '' }],
    ])
    const r = await new WaybackClient({ fetch, ...noDelay }).recover(LINK)
    expect(r.status).toBe('missing')
  })

  it('reports missing, with every URL it tried, when nothing was captured', async () => {
    const { fetch } = fakeFetch([['cdx/search/cdx', { body: '' }]])
    const r = await new WaybackClient({ fetch, ...noDelay }).recover(LINK)
    expect(r.status).toBe('missing')
    if (r.status === 'missing') expect(r.tried).toContain('twitpic.com/517yh')
  })

  it('backs off and retries when archive.org says 429', async () => {
    let n = 0
    const waits: number[] = []
    const { fetch } = fakeFetch([
      ['cdx/search/cdx?url=twitpic.com%2Fshow%2Ffull', () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '7' } } : { body: cdx(['20120101000000', 'http://twitpic.com/show/full/517yh', 'image/jpeg']) })],
      ['id_/http://twitpic.com/show/full/517yh', { body: JPEG }],
    ])
    const r = await new WaybackClient({ fetch, delayMs: 0, sleep: async (ms) => void waits.push(ms) }).recover(LINK)
    expect(r.status).toBe('found')
    expect(waits).toContain(7000)
  })

  it('reports an error rather than missing when the index keeps failing', async () => {
    const { fetch } = fakeFetch([['cdx/search/cdx', { status: 503 }]])
    const r = await new WaybackClient({ fetch, ...noDelay, retries: 1 }).recover(LINK)
    expect(r.status).toBe('error')
  })
})
