import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect } from 'drizzle-orm/pg-core'
import { MARK_UPSERT_GUARD, UNKNOWN_DATE_BACKFILL, WATCHED_AT_BACKFILL } from './sync-neodb-marks.js'
import { SENTINEL_WINDOW } from '../lib/neodb-mark.js'

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

  it('never refills a row flagged "date unknown" — its null IS the date', () => {
    // The sentinel is still in raw. Without this guard every forced repair would read it
    // back into watched_at and undo the decode, silently.
    expect(sql).toContain('NOT watched_date_unknown')
  })
})

// The "date unknown" sentinel (ADR 0060) is decoded to a null date, which is exactly the
// state the upsert's null-fill arm was written to repair. The Create that precedes a
// sentinel Update carries "today", and a redelivery of it — or the repair job replaying it
// out of objects.raw — would refill the deliberately-cleared date as "watched today".
describe('MARK_UPSERT_GUARD', () => {
  const { sql } = dialect.sqlToQuery(MARK_UPSERT_GUARD)

  it('keeps the strictly-newer overwrite and the null-fill arm', () => {
    expect(sql).toContain('excluded.updated_at_ap > "neodb_marks"."updated_at_ap"')
    expect(sql).toContain('"neodb_marks"."watched_at" is null')
    expect(sql).toContain('excluded.watched_at is not null')
  })

  it('the null-fill arm requires the row NOT be flagged "date unknown"', () => {
    expect(sql).toMatch(/"neodb_marks"\."watched_at" is null and not "neodb_marks"\."watched_date_unknown" and excluded\.watched_at is not null/)
  })

  it('lets a sentinel win a stamp tie, the same way a date does', () => {
    expect(sql).toContain('excluded.updated_at_ap = "neodb_marks"."updated_at_ap" and excluded.watched_date_unknown and not "neodb_marks"."watched_date_unknown"')
  })
})

describe('UNKNOWN_DATE_BACKFILL', () => {
  const { sql, params } = dialect.sqlToQuery(UNKNOWN_DATE_BACKFILL)

  it('decodes the sentinel to a null date with the flag set', () => {
    expect(sql).toContain('SET watched_at = NULL')
    expect(sql).toContain('watched_date_unknown = true')
    expect(sql).toContain('RETURNING id')
  })

  it('is idempotent — a flagged row is never touched again', () => {
    expect(sql).toContain('WHERE NOT watched_date_unknown')
  })

  it('binds the parser\'s own window, so SQL and parser cannot drift', () => {
    expect(params).toEqual([SENTINEL_WINDOW.from, SENTINEL_WINDOW.to])
    expect(sql).toContain('watched_at >= $1::timestamptz')
    expect(sql).toContain('watched_at < $2::timestamptz')
  })

  it('the migration that ran the decode once carries the same two bounds', () => {
    const migration = readFileSync(
      join(__dirname, '../../drizzle/0041_mark_watched_date_unknown.sql'),
      'utf8',
    )
    expect(migration).toContain(`'${SENTINEL_WINDOW.from}'::timestamptz`)
    expect(migration).toContain(`'${SENTINEL_WINDOW.to}'::timestamptz`)
    expect(migration).toContain('"watched_date_unknown" = true')
  })
})
