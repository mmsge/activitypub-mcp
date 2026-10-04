import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PgDialect } from 'drizzle-orm/pg-core'
import { and, type SQL } from 'drizzle-orm'

// No test database in this repo: a tool test asserts on the SQL it would have sent.
const getDb = vi.fn(() => {
  throw new Error('pages-timeline tests must not touch the database')
})
vi.mock('../../db/client.js', () => ({ getDb }))

const {
  bucketExpr, dayExpr, countingConditions, dateWindowConditions, bookCondition,
  getPagesTimelineSchema, getPagesTimelineRestSchema, getPagesTimeline,
} = await import('./pages-timeline.js')
const { endpoints } = await import('../../rest/table.js')
const { coerceQuery } = await import('../../rest/coerce.js')

const dialect = new PgDialect()
const render = (s: SQL) => dialect.sqlToQuery(s)

describe('the SQL never converts a timezone', () => {
  // entry_date is ALREADY Markus' local day; sidetal recorded what StoryGraph shows.
  // Any AT TIME ZONE here would be a second conversion, and it would move evening
  // entries onto the wrong day without a single query failing.
  const fragments: Array<[string, SQL]> = [
    ['bucket day', bucketExpr('day')],
    ['bucket week', bucketExpr('week')],
    ['bucket month', bucketExpr('month')],
    ['day', dayExpr()],
    ['counting', and(...countingConditions('nora'))!],
    ['window', and(...dateWindowConditions('2026-01-01', '2026-12-31'))!],
  ]
  for (const [label, frag] of fragments) {
    it(`${label}: no AT TIME ZONE, no timestamptz`, () => {
      const { sql } = render(frag)
      expect(sql).not.toMatch(/AT TIME ZONE/i)
      expect(sql).not.toMatch(/timestamptz/i)
      expect(sql).not.toMatch(/now\(\)/i)
    })
  }

  it('truncates the DATE column through a zone-free timestamp, and binds the bucket', () => {
    // date_trunc/to_char have no date overloads; a bare date resolves to their
    // timestamptz variants, which read the session TimeZone. `::timestamp` prevents that.
    const { sql, params } = render(bucketExpr('week'))
    expect(sql).toBe(`to_char(date_trunc($1, "storygraph_journal_entries"."entry_date"::timestamp), 'YYYY-MM-DD')`)
    expect(params).toEqual(['week'])
  })
})

describe('countingConditions', () => {
  it('excludes deleted, undated and pages-less entries', () => {
    const { sql } = render(and(...countingConditions())!)
    expect(sql).toContain('"deleted_at" is null')
    expect(sql).toContain('"entry_date" is not null')
    expect(sql).toContain('"pages_read" is not null')
  })

  it('never reads pages_total — a day is the sum of StoryGraph\'s own deltas', () => {
    expect(render(and(...countingConditions('x'))!).sql).not.toContain('pages_total')
  })

  it('binds the book filter: exact id or title substring', () => {
    const evil = "x'; DROP TABLE storygraph_journal_entries; --"
    const { sql, params } = render(bookCondition(evil))
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).toContain('"book_id" = $1')
    expect(sql).toContain('"book_title" ilike $2')
    expect(params).toEqual([evil, `%${evil}%`])
  })
})

describe('dateWindowConditions', () => {
  it('is inclusive on both ends of the date column, with bound dates', () => {
    const { sql, params } = render(and(...dateWindowConditions('2026-09-01', '2026-09-30'))!)
    expect(sql).toContain('"entry_date" >= $1::date')
    expect(sql).toContain('"entry_date" <= $2::date')
    expect(params).toEqual(['2026-09-01', '2026-09-30'])
  })

  it('is empty with no bounds', () => {
    expect(dateWindowConditions()).toEqual([])
  })
})

describe('the two schemas', () => {
  it('defaults MCP to a weekly, top-5 answer', () => {
    expect(getPagesTimelineSchema.parse({})).toEqual({ bucket: 'week', top_n: 5, include_empty_buckets: true })
  })

  it('defaults REST to the whole daily series', () => {
    expect(getPagesTimelineRestSchema.parse({})).toEqual({ bucket: 'day', top_n: 0, include_empty_buckets: true })
  })

  it('differs from MCP in those two defaults and nothing else', () => {
    const mcp = getPagesTimelineSchema.parse({}) as Record<string, unknown>
    const rest = getPagesTimelineRestSchema.parse({}) as Record<string, unknown>
    expect(Object.keys(mcp).filter((k) => mcp[k] !== rest[k]).sort()).toEqual(['bucket', 'top_n'])
    expect(Object.keys(getPagesTimelineSchema.shape).sort()).toEqual(Object.keys(getPagesTimelineRestSchema.shape).sort())
  })

  it('has no timezone parameter, because the dates are already local', () => {
    expect(Object.keys(getPagesTimelineSchema.shape)).not.toContain('timezone')
  })

  it('reduces a datetime bound to its date and refuses junk, without a connection', () => {
    expect(getPagesTimelineSchema.parse({ from: '2026-10-04T23:30:00+02:00' }).from).toBe('2026-10-04')
    expect(getPagesTimelineSchema.safeParse({ from: '4 Oct 2026' }).success).toBe(false)
    expect(getPagesTimelineSchema.safeParse({ bucket: 'year' }).success).toBe(false)
    expect(getPagesTimelineSchema.safeParse({ top_n: -1 }).success).toBe(false)
    expect(getDb).not.toHaveBeenCalled()
  })
})

describe('the REST endpoint', () => {
  const entry = endpoints.find((e) => e.path === '/pages-timeline')

  it('is registered against the REST schema and the shared handler', () => {
    expect(entry?.name).toBe('get_pages_timeline')
    expect(entry!.schema).toBe(getPagesTimelineRestSchema)
    expect(entry!.handler).toBe(getPagesTimeline)
  })

  it('declares every parameter that needs coercing out of a query string', () => {
    const query: Record<string, string[]> = {
      bucket: ['month'], top_n: ['3'], include_empty_buckets: ['false'],
      from: ['2026-01-01'], to: ['2026-02-01'], book: ['nora'],
    }
    const parsed = getPagesTimelineRestSchema.safeParse(coerceQuery(query, entry!))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({
      bucket: 'month', top_n: 3, include_empty_buckets: false, from: '2026-01-01', to: '2026-02-01', book: 'nora',
    })
    expect(Object.keys(query).sort()).toEqual(Object.keys(getPagesTimelineRestSchema.shape).sort())
  })
})

describe('migration 0042', () => {
  const migration = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle/0042_storygraph_journal.sql'),
    'utf8',
  )
  const ddl = migration.split('\n').filter((l) => !l.startsWith('--')).join('\n')

  it('stores the journal day as a DATE, not an instant', () => {
    expect(ddl).toMatch(/"entry_date" date,/)
  })

  it('keeps sidetal\'s updated_at as the cursor column, indexed', () => {
    expect(ddl).toMatch(/"source_updated_at" timestamp with time zone NOT NULL/)
    expect(ddl).toContain('"storygraph_journal_entries_source_updated_idx"')
    expect(ddl).toContain('"storygraph_journal_entries_date_idx"')
    expect(ddl).toContain('"storygraph_journal_entries_book_idx"')
  })
})
