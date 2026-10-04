import { describe, it, expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { and, type SQL } from 'drizzle-orm'
import { InvalidCursorError } from './pagination.js'

const getDb = vi.fn(() => {
  throw new Error('journal-entries tests must not touch the database')
})
vi.mock('../../db/client.js', () => ({ getDb }))

const {
  getJournalEntriesSchema, getJournalEntries, journalConditions, journalKeysetCondition, journalOrderBy,
  encodeJournalCursor, decodeJournalCursor,
} = await import('./journal-entries.js')
const { endpoints } = await import('../../rest/table.js')
const { coerceQuery } = await import('../../rest/coerce.js')

const dialect = new PgDialect()
const render = (s: SQL) => dialect.sqlToQuery(s)

describe('getJournalEntriesSchema', () => {
  it('pins its defaults: deleted entries out, 50 a page', () => {
    expect(getJournalEntriesSchema.parse({})).toEqual({ include_deleted: false, limit: 50 })
  })

  it('accepts only the four kinds sidetal emits', () => {
    for (const kind of ['progress', 'started', 'finished', 'percent', 'dnf']) {
      expect(getJournalEntriesSchema.safeParse({ kind }).success).toBe(true)
    }
    expect(getJournalEntriesSchema.safeParse({ kind: 'reading' }).success).toBe(false)
  })
})

describe('journalConditions', () => {
  it('leaves deleted entries out by default and lets include_deleted bring them back', () => {
    expect(render(and(...journalConditions({ include_deleted: false }))!).sql).toContain('"deleted_at" is null')
    expect(journalConditions({ include_deleted: true })).toEqual([])
  })

  it('filters on the date column directly, with no zone', () => {
    const { sql, params } = render(and(...journalConditions({ include_deleted: false, from: '2026-10-01', to: '2026-10-04', kind: 'progress', book: 'nora' }))!)
    expect(sql).not.toMatch(/AT TIME ZONE/i)
    expect(sql).toContain('"entry_date" >= $1::date')
    expect(sql).toContain('"entry_date" <= $2::date')
    expect(sql).toContain('"kind" = $5')
    expect(params).toEqual(['2026-10-01', '2026-10-04', 'nora', '%nora%', 'progress'])
  })
})

describe('the journal cursor', () => {
  it('round-trips a dated and an undated position', () => {
    expect(decodeJournalCursor(encodeJournalCursor('2026-10-04', 'abc'))).toEqual({ d: '2026-10-04', id: 'abc' })
    expect(decodeJournalCursor(encodeJournalCursor(null, 'abc'))).toEqual({ d: null, id: 'abc' })
  })

  it('refuses a bad token as a caller error (REST maps it to 400)', () => {
    expect(() => decodeJournalCursor('not-base64-json')).toThrow(InvalidCursorError)
    const wrongShape = Buffer.from(JSON.stringify({ d: '2026-10-04T00:00:00Z', id: 'x' })).toString('base64url')
    expect(() => decodeJournalCursor(wrongShape)).toThrow(InvalidCursorError)
  })

  it('orders newest day first with undated last, byte-wise on the id', () => {
    const { sql } = render(journalOrderBy())
    expect(sql).toMatch(/"entry_date" DESC NULLS LAST, .*"id" COLLATE "C" DESC/)
  })

  it('selects strictly past the cursor and keeps the undated tail reachable', () => {
    const dated = render(journalKeysetCondition({ d: '2026-10-04', id: 'm' }))
    expect(dated.sql).toContain('"entry_date" < $1::date')
    expect(dated.sql).toContain('"entry_date" IS NULL')
    expect(dated.sql).not.toMatch(/timestamptz|AT TIME ZONE/i)
    expect(dated.params).toEqual(['2026-10-04', '2026-10-04', 'm'])

    const undated = render(journalKeysetCondition({ d: null, id: 'm' }))
    expect(undated.sql).toMatch(/^\("storygraph_journal_entries"\."entry_date" IS NULL AND/)
  })

  it('rejects a bad cursor before opening a connection', async () => {
    await expect(getJournalEntries(getJournalEntriesSchema.parse({ cursor: '%%%' }))).rejects.toThrow(InvalidCursorError)
    expect(getDb).not.toHaveBeenCalled()
  })
})

describe('the REST endpoint', () => {
  const entry = endpoints.find((e) => e.path === '/journal-entries')

  it('is registered with the MCP schema and handler', () => {
    expect(entry?.name).toBe('get_journal_entries')
    expect(entry!.schema).toBe(getJournalEntriesSchema)
    expect(entry!.handler).toBe(getJournalEntries)
  })

  it('declares every parameter that needs coercing out of a query string', () => {
    const query: Record<string, string[]> = {
      from: ['2026-10-01'], to: ['2026-10-04'], book: ['nora'], kind: ['finished'],
      include_deleted: ['true'], limit: ['10'], cursor: [encodeJournalCursor('2026-10-02', 'x')],
    }
    const parsed = getJournalEntriesSchema.safeParse(coerceQuery(query, entry!))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ include_deleted: true, limit: 10, kind: 'finished' })
    expect(Object.keys(query).sort()).toEqual(Object.keys(getJournalEntriesSchema.shape).sort())
  })
})
