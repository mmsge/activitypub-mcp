import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { scrobbles } from '../../db/schema.js'
import {
  encodeCursor,
  decodeCursor,
  keysetCondition,
  keysetOrderBy,
  InvalidCursorError,
} from './pagination.js'

const dialect = new PgDialect()
const ts = new Date('2026-07-03T07:02:11.000Z')
const id = '19a2c7d2-2229-4b7a-9abd-dd9de3e9d847'

// get_watched sorts on the item's newest shelf date, which is a correlated subquery over
// neodb_marks rather than a column on the table being paged. The keyset helpers therefore
// have to take a sql expression as the ordering key, not just a PgColumn.
describe('a sql expression as the ordering key', () => {
  const expr = sql`(SELECT max(m.watched_at) FROM neodb_marks m WHERE m.item_url = catalog_metadata.item_url)`

  it('orders by the expression itself, nulls last in both directions', () => {
    for (const order of ['asc', 'desc'] as const) {
      const { sql: rendered } = dialect.sqlToQuery(keysetOrderBy(expr, scrobbles.id, order))
      expect(rendered).toContain('max(m.watched_at)')
      expect(rendered).toContain('NULLS LAST')
      expect(rendered).toContain(order === 'asc' ? 'ASC' : 'DESC')
    }
  })

  it('builds a cursor condition against the expression, still binding only strings', () => {
    const { sql: rendered, params } = dialect.sqlToQuery(
      keysetCondition(expr, scrobbles.id, { p: ts.toISOString(), id }, 'desc'),
    )
    expect(rendered).toContain('max(m.watched_at)')
    for (const param of params) expect(typeof param).toBe('string')
    expect(params).toContain(ts.toISOString())
  })
})

describe('keysetCondition', () => {
  // Regression: a Date bound inside a raw sql`` fragment reaches the driver as
  // its toString() form ("Fri Jul 03 2026 ... (Coordinated Universal Time)"),
  // which Postgres can't cast to timestamptz — every cursor follow-up 500'd.
  // The cursor's ISO string must be bound as-is.
  it('binds only strings — never Date objects', () => {
    for (const order of ['asc', 'desc'] as const) {
      const cond = keysetCondition(scrobbles.playedAt, scrobbles.id, { p: ts.toISOString(), id }, order)
      const { params } = dialect.sqlToQuery(cond)
      expect(params.length).toBeGreaterThan(0)
      for (const param of params) {
        expect(typeof param).toBe('string')
      }
      expect(params).toContain(ts.toISOString())
      expect(params).toContain(id)
    }
  })

  it('compares only ids once inside the trailing null-timestamp section', () => {
    const cond = keysetCondition(scrobbles.playedAt, scrobbles.id, { p: null, id }, 'desc')
    const { sql, params } = dialect.sqlToQuery(cond)
    expect(sql).toContain('IS NULL')
    expect(params).toEqual([id])
  })
})

// The public stream merges lanes from tables with unrelated ids, so it pages on a
// synthetic "<kind>:<id>" text tiebreaker instead of a uuid.
describe('a text tiebreaker (idCast: "text")', () => {
  const ref = 'post:19a2c7d2-2229-4b7a-9abd-dd9de3e9d847'

  it('casts to text, not uuid — a "post:<uuid>" label is not a uuid', () => {
    const { sql } = dialect.sqlToQuery(
      keysetCondition(scrobbles.playedAt, scrobbles.id, { p: ts.toISOString(), id: ref }, 'desc', 'text'),
    )
    expect(sql).toContain('::text')
    expect(sql).not.toContain('::uuid')
  })

  it('forces the C collation on both sides, so ordering is byte-stable', () => {
    const cond = dialect.sqlToQuery(
      keysetCondition(scrobbles.playedAt, scrobbles.id, { p: ts.toISOString(), id: ref }, 'desc', 'text'),
    ).sql
    const order = dialect.sqlToQuery(
      keysetOrderBy(scrobbles.playedAt, scrobbles.id, 'desc', 'text'),
    ).sql
    // Both the compared column and the bound value, or the keyset skips/repeats rows.
    expect(cond.match(/COLLATE "C"/g)?.length).toBe(2)
    expect(order).toContain('COLLATE "C"')
  })

  it('leaves the uuid default untouched for every existing caller', () => {
    const { sql } = dialect.sqlToQuery(
      keysetCondition(scrobbles.playedAt, scrobbles.id, { p: ts.toISOString(), id }, 'desc'),
    )
    expect(sql).toContain('::uuid')
    expect(sql).not.toContain('COLLATE')
    expect(dialect.sqlToQuery(keysetOrderBy(scrobbles.playedAt, scrobbles.id, 'desc')).sql)
      .not.toContain('COLLATE')
  })
})

describe('keysetOrderBy', () => {
  it('sorts null timestamps last in both directions', () => {
    for (const order of ['asc', 'desc'] as const) {
      const { sql } = dialect.sqlToQuery(keysetOrderBy(scrobbles.playedAt, scrobbles.id, order))
      expect(sql.toLowerCase()).toContain(`${order} nulls last`)
    }
  })
})

describe('cursor encode/decode', () => {
  it('round-trips a null-timestamp cursor', () => {
    const decoded = decodeCursor(encodeCursor(null, id))
    expect(decoded.p).toBeNull()
    expect(decoded.id).toBe(id)
  })

  it('rejects a garbage token', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(InvalidCursorError)
    expect(() => decodeCursor('not-base64-json')).toThrow('Invalid cursor: not a valid token')
  })

  it('rejects a well-formed token with the wrong shape', () => {
    const token = Buffer.from(JSON.stringify({ p: 'not a date', id: 42 }), 'utf8').toString('base64url')
    expect(() => decodeCursor(token)).toThrow(InvalidCursorError)
    expect(() => decodeCursor(token)).toThrow('Invalid cursor: malformed payload')
  })
})
