// What this job must get right, none of which shows up as a failing query:
//
//   1. Blank config is a no-op — the job ships before sidetal is deployed.
//   2. A refused token, a 503 or a malformed body is a FAILURE, never an empty success.
//   3. `date` is stored verbatim as the local day; it never becomes a JS Date.
//   4. `pages_read` is taken as StoryGraph's own delta, never derived from pages_total.
//   5. A re-poll never rewrites first_seen_at, and never moves a row backwards.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

let db: unknown = null
const getDb = vi.fn(() => {
  if (!db) throw new Error('getDb() must not be called here')
  return db
})
vi.mock('../db/client.js', () => ({ getDb }))

const recordAttempt = vi.fn(async () => {})
const recordSuccess = vi.fn(async () => {})
const recordFailure = vi.fn(async () => {})
vi.mock('../lib/source-health.js', () => ({
  STORYGRAPH_SOURCE: 'storygraph',
  recordAttempt, recordSuccess, recordFailure,
}))

const { config } = await import('../config.js')
const {
  toEntryRow, toBookRow, entryUpdateSet, ENTRY_UPDATE_WHERE, dedupeById, cursorFrom, entryDateOf,
  syncStorygraph, CURSOR_OVERLAP_MS,
} = await import('./sync-storygraph.js')

const ENTRY = {
  id: '0b9a5f7e-1111-4c1e-9a55-6f1d6c2b0001',
  book_id: '6d1c1f7e-2222-4c1e-9a55-6f1d6c2b0002',
  book_title: 'Ubesvart anrop',
  date: '2026-10-04',
  kind: 'progress',
  pages_read: 42,
  pages_total: 130,
  book_pages: 352,
  percent: 37.0,
  first_seen_at: '2026-10-04T19:56:02.210000Z',
  last_seen_at: '2026-10-04T21:00:00.000000Z',
  updated_at: '2026-10-04T21:00:00.123456Z',
  deleted_at: null,
}

describe('toEntryRow', () => {
  it('maps every field, keeping the date as the string it arrived as', () => {
    const row = toEntryRow(ENTRY)!
    expect(row.entryDate).toBe('2026-10-04')
    expect(typeof row.entryDate).toBe('string')
    expect(row).toMatchObject({
      id: ENTRY.id, bookId: ENTRY.book_id, bookTitle: 'Ubesvart anrop', kind: 'progress',
      pagesRead: 42, pagesTotal: 130, bookPages: 352, percent: 37, deletedAt: null,
    })
    expect(row.sourceUpdatedAt.toISOString()).toBe('2026-10-04T21:00:00.123Z')
    expect(row.firstSeenAt.toISOString()).toBe('2026-10-04T19:56:02.210Z')
    expect(row.raw).toBe(ENTRY)
  })

  it('never derives pages_read from pages_total', () => {
    // A percent-only update or a started marker has no delta. Back-filling one from the
    // cumulative position would invent reading that StoryGraph never recorded.
    const row = toEntryRow({ ...ENTRY, kind: 'percent', pages_read: null, pages_total: 200 })!
    expect(row.pagesRead).toBeNull()
    expect(row.pagesTotal).toBe(200)
  })

  it('stores an undated entry as undated rather than guessing a day', () => {
    expect(toEntryRow({ ...ENTRY, date: null })!.entryDate).toBeNull()
    expect(entryDateOf('2026-10-04T22:30:00Z')).toBeNull()
    expect(entryDateOf('04.10.2026')).toBeNull()
  })

  it('carries a deletion through, so the row is kept and filtered rather than lost', () => {
    expect(toEntryRow({ ...ENTRY, deleted_at: '2026-10-05T03:00:00Z' })!.deletedAt?.toISOString()).toBe('2026-10-05T03:00:00.000Z')
  })

  it('drops an entry without id, book_id or updated_at', () => {
    expect(toEntryRow({ ...ENTRY, id: undefined })).toBeNull()
    expect(toEntryRow({ ...ENTRY, book_id: '' })).toBeNull()
    expect(toEntryRow({ ...ENTRY, updated_at: 'not a date' })).toBeNull()
  })
})

describe('toBookRow', () => {
  it('keeps only string authors and requires an id', () => {
    expect(toBookRow({ id: 'b', title: 'T', authors: ['A', 3, null], pages: 352, cover_url: null })).toMatchObject({
      id: 'b', title: 'T', authors: ['A'], pages: 352, coverUrl: null,
    })
    expect(toBookRow({ title: 'no id' })).toBeNull()
  })
})

describe('entryUpdateSet', () => {
  it('never rewrites first_seen_at or the key', () => {
    const set = entryUpdateSet()
    expect(set).not.toHaveProperty('firstSeenAt')
    expect(set).not.toHaveProperty('id')
    expect(set).toHaveProperty('deletedAt') // a deletion must propagate
    expect(set).toHaveProperty('sourceUpdatedAt')
  })

  it('only moves a row forwards in sidetal time', () => {
    const { sql } = new PgDialect().sqlToQuery(ENTRY_UPDATE_WHERE)
    expect(sql).toBe('excluded."source_updated_at" >= "storygraph_journal_entries"."source_updated_at"')
  })
})

describe('dedupeById', () => {
  it('keeps the newest copy of a row within one batch', () => {
    const a = toEntryRow(ENTRY)!
    const b = toEntryRow({ ...ENTRY, pages_read: 50, updated_at: '2026-10-04T22:00:00Z' })!
    expect(dedupeById([b, a])).toEqual([b])
    expect(dedupeById([a, b])).toEqual([b])
  })
})

describe('cursorFrom', () => {
  it('is undefined on an empty table, so the first run reads everything', () => {
    expect(cursorFrom(null)).toBeUndefined()
  })

  it('starts a little behind the newest row, as an ISO instant with Z', () => {
    // since_updated is exclusive and one scrape can stamp many rows with one instant.
    const c = cursorFrom(new Date('2026-10-04T21:00:00.123Z'))!
    expect(c).toBe(new Date(Date.parse('2026-10-04T21:00:00.123Z') - CURSOR_OVERLAP_MS).toISOString())
    expect(c.endsWith('Z')).toBe(true)
  })
})

// ---- the run itself, against a stubbed sidetal and a recording fake db ------

type Insert = { values: unknown[] }
function fakeDb(maxMs: string | null) {
  const inserts: Insert[] = []
  const handle = {
    select: () => ({ from: () => Promise.resolve([{ ms: maxMs }]) }),
    insert: () => ({
      values: (values: unknown[]) => ({
        onConflictDoUpdate: () => {
          inserts.push({ values })
          return Promise.resolve()
        },
      }),
    }),
  }
  return { handle, inserts }
}

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('syncStorygraph', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    recordAttempt.mockClear(); recordSuccess.mockClear(); recordFailure.mockClear()
    getDb.mockClear()
    db = null
    config.STORYGRAPH_API_URL = ''
    config.STORYGRAPH_API_TOKEN = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    config.STORYGRAPH_API_URL = ''
    config.STORYGRAPH_API_TOKEN = ''
  })

  it('is a no-op until BOTH the URL and the token are set (deploy-then-arm)', async () => {
    config.STORYGRAPH_API_URL = 'http://172.18.0.1:4008'
    await syncStorygraph()
    config.STORYGRAPH_API_URL = ''
    config.STORYGRAPH_API_TOKEN = 'secret'
    await syncStorygraph()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getDb).not.toHaveBeenCalled()
    expect(recordAttempt).not.toHaveBeenCalled()
  })

  it('follows next_cursor, sends since_updated from the stored data, and the token only in a header', async () => {
    config.STORYGRAPH_API_URL = 'http://172.18.0.1:4008/'
    config.STORYGRAPH_API_TOKEN = 'secret'
    const fake = fakeDb(String(Date.parse('2026-10-03T03:00:00.000Z')))
    db = fake.handle
    fetchMock
      .mockResolvedValueOnce(json(200, { entries: [ENTRY], next_cursor: 'c2' }))
      .mockResolvedValueOnce(json(200, { entries: [{ ...ENTRY, id: 'second', deleted_at: '2026-10-04T23:00:00Z' }], next_cursor: null }))
      .mockResolvedValueOnce(json(200, { books: [{ id: ENTRY.book_id, title: 'Ubesvart anrop', authors: ['Nora Dåsnes'], pages: 352 }] }))

    await syncStorygraph()

    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toBe('http://172.18.0.1:4008/api/v1/entries?since_updated=2026-10-03T02%3A59%3A59.000Z&limit=1000')
    expect(urls[1]).toContain('cursor=c2')
    expect(urls[1]).toContain('since_updated=')
    expect(urls[2]).toBe('http://172.18.0.1:4008/api/v1/books')
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('secret')
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret' })
    }

    expect(fake.inserts).toHaveLength(3) // two entry pages, one books batch
    expect(recordFailure).not.toHaveBeenCalled()
    expect(recordSuccess).toHaveBeenCalledTimes(1)
    const [source, items, trace] = recordSuccess.mock.calls[0] as unknown as [string, number, { note: string }]
    expect(source).toBe('storygraph')
    expect(items).toBe(3)
    expect(trace.note).toContain('2 upserted (1 carrying a deletion)')
  })

  it('records a 401 as a failure — never as an empty, successful run', async () => {
    config.STORYGRAPH_API_URL = 'http://172.18.0.1:4008'
    config.STORYGRAPH_API_TOKEN = 'wrong'
    db = fakeDb(null).handle
    fetchMock.mockResolvedValueOnce(json(401, { detail: 'bad token' }))

    await syncStorygraph()

    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordFailure).toHaveBeenCalledTimes(1)
    expect(recordFailure.mock.calls[0].slice(0, 2)).toEqual(['storygraph', 401])
  })

  it('treats a 200 that is not the contract (an HTML page, a renamed field) as a failure', async () => {
    config.STORYGRAPH_API_URL = 'http://172.18.0.1:4008'
    config.STORYGRAPH_API_TOKEN = 'secret'
    db = fakeDb(null).handle
    fetchMock.mockResolvedValueOnce(json(200, { items: [], next: null }))

    await syncStorygraph()

    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordFailure.mock.calls[0].slice(0, 3)).toEqual(['storygraph', 200, 'Body does not match the sidetal contract'])
  })

  it('records a dead connection as status 0', async () => {
    config.STORYGRAPH_API_URL = 'http://172.18.0.1:4008'
    config.STORYGRAPH_API_TOKEN = 'secret'
    db = fakeDb(null).handle
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 172.18.0.1:4008'))

    await syncStorygraph()

    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordFailure.mock.calls[0].slice(0, 2)).toEqual(['storygraph', 0])
  })
})
