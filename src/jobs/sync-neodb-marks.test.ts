import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { WATCHED_AT_BACKFILL } from './sync-neodb-marks.js'

const dialect = new PgDialect()

// `watched_at` was added after the 2016 film batch was ingested, and `upsertNeodbMark`
// deliberately no-ops on an unchanged `updated` stamp, so this statement is the only thing
// that populates the column for existing rows. Every way it can be wrong is silent: it
// reports "0 filled" and looks like there was nothing to do.
describe('WATCHED_AT_BACKFILL', () => {
  const { sql } = dialect.sqlToQuery(WATCHED_AT_BACKFILL)

  // The bug this test exists for: `~ '^\d{4}-\d{2}-\d{2}'` inside a JS template literal
  // ships as `^dddd-dd-dd`, because the template literal eats the backslash. Postgres
  // accepts it happily, matches nothing, and the backfill fills zero rows in silence.
  it('spells the date-shape guard as a character class, not \\d', () => {
    expect(sql).toContain('[0-9]{4}-[0-9]{2}-[0-9]{2}')
    expect(sql).not.toContain('dddd')
    expect(sql).not.toMatch(/~\s*'\^d/)
  })

  it('reads the date off the Status entry in the row\'s own stored raw', () => {
    expect(sql).toContain(`raw->'relatedWith'->>'published'`)
    expect(sql).toContain(`raw->'relatedWith'->>'type' = 'Status'`)
    // A pre-array-normalisation row could hold something other than an object here.
    expect(sql).toContain(`jsonb_typeof(raw->'relatedWith') = 'object'`)
  })

  it('only ever fills a null — a stored date is never overwritten', () => {
    expect(sql).toContain('watched_at IS NULL')
  })

  it('returns the filled rows so the repair job can report a count', () => {
    expect(sql).toContain('RETURNING id')
  })
})
