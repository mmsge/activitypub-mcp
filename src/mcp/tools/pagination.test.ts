import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
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
