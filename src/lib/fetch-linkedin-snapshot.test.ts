// Four things about this endpoint will bite anyone who writes it from reflex, and
// each has a test here:
//
//   1. `Linkedin-Version: 202312` is the only accepted value — anything else is a
//      426, including a "helpful" bump to the current DMA version number.
//   2. `start` is a page index, not a record offset. Advancing by `count` reads
//      page 0 then page 10 and silently loses nine pages.
//   3. `paging.total` under-reports, so it must not terminate the loop.
//   4. The end of data arrives AS an error response — so status must be read
//      after the no-data check, and a 401 must not be mistaken for "finished".
//
// (4) is the one that matters most: the token is hand-minted with an unknown
// expiry, so mistaking its death for a completed crawl is the likeliest way this
// source silently stops working.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSnapshotPage } from './fetch-linkedin-snapshot.js'

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'x',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  ...extra,
  elements: [{ snapshotDomain: 'MEMBER_SHARE_INFO', snapshotData: items }],
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSnapshotPage', () => {
  it('sends the only version the endpoint accepts', async () => {
    const fn = respond(page([{ 'Shared URL': 'x' }]))
    await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Linkedin-Version']).toBe('202312')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('asks for the requested domain and start', async () => {
    const fn = respond(page([{ a: 1 }]))
    await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 3)

    const [url] = fn.mock.calls[0] as unknown as [string]
    expect(url).toContain('domain=MEMBER_SHARE_INFO')
    expect(url).toContain('start=3')
    expect(url).toContain('q=criteria')
  })

  it('returns the payload from elements[0].snapshotData', async () => {
    respond(page([{ 'Shared URL': 'https://example.com' }, { 'Shared URL': 'https://example.org' }]))
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    expect(r.kind).toBe('data')
    if (r.kind !== 'data') return
    expect(r.items).toHaveLength(2)
  })

  it('advances start by page index, not by count', async () => {
    // The docs' own sample: count 10 at start 0, next link at start=1.
    respond(
      page([{ a: 1 }], {
        paging: {
          start: 0,
          count: 10,
          total: 2,
          links: [{ rel: 'next', href: '/rest/memberSnapshotData?count=10&q=criteria&start=1' }],
        },
      }),
    )
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    expect(r.kind).toBe('data')
    if (r.kind !== 'data') return
    expect(r.nextStart).toBe(1)
    expect(r.nextStart).not.toBe(10)
  })

  it('keeps going past a paging.total that says the data is exhausted', async () => {
    // total:2 while sitting at start 5 with rows still coming — the documented
    // condition, because some data is assembled offline.
    respond(page([{ a: 1 }], { paging: { start: 5, count: 10, total: 2, links: [] } }))
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 5)

    expect(r.kind).toBe('data')
    if (r.kind !== 'data') return
    expect(r.nextStart).toBe(6)
  })

  it('ignores a next link that would move backwards', async () => {
    respond(
      page([{ a: 1 }], {
        paging: { links: [{ rel: 'next', href: '/rest/memberSnapshotData?start=0' }] },
      }),
    )
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 4)

    expect(r.kind).toBe('data')
    if (r.kind !== 'data') return
    expect(r.nextStart).toBe(5)
  })

  it('ends cleanly on the documented no-data message, even though it is an error response', async () => {
    respond({ message: 'No data found for this memberId', status: 404 }, { ok: false, status: 404 })
    expect(await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 9)).toEqual({ kind: 'end' })
  })

  it('ends on an empty snapshotData', async () => {
    respond(page([]))
    expect(await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 9)).toEqual({ kind: 'end' })
  })

  it('reports an expired token as an error, NOT as the end of the data', async () => {
    respond({ message: 'Invalid access token', status: 401 }, { ok: false, status: 401 })
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    expect(r.kind).toBe('error')
    if (r.kind !== 'error') return
    expect(r.status).toBe(401)
  })

  it('reports a wrong Linkedin-Version (426) as an error', async () => {
    respond({ message: 'NONEXISTENT_VERSION', status: 426 }, { ok: false, status: 426 })
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    expect(r.kind).toBe('error')
    if (r.kind !== 'error') return
    expect(r.status).toBe(426)
  })

  it('reports a network failure as an error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)

    expect(r.kind).toBe('error')
    if (r.kind !== 'error') return
    expect(r.status).toBe(0)
    expect(r.message).toContain('ECONNRESET')
  })

  it('reports an unparseable body as an error, not as the end', async () => {
    respond('<html>502 Bad Gateway</html>')
    const r = await fetchSnapshotPage('tok', 'MEMBER_SHARE_INFO', 0)
    expect(r.kind).toBe('error')
  })
})
