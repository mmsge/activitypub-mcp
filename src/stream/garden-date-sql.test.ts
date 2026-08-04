import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { ownGardenDateOn, gardenEventAtOn } from './garden-date-sql.js'

// Shape assertions only — what these expressions actually *do* is verified by
// running them against Postgres (see the PR body); this pins the parts that a
// refactor could quietly break without any query failing.
const dialect = new PgDialect()
const render = (s: SQL): string => dialect.sqlToQuery(s).sql

describe('ownGardenDateOn', () => {
  it('guards the cast with a CASE, not with a WHERE', () => {
    // A WHERE that filters unparseable rows is a bet on evaluation order.
    // "ein gong i fjor" must be unreachable by the cast, not merely filtered later.
    const text = render(ownGardenDateOn('g'))
    expect(text).toMatch(/CASE WHEN g\.note_date ~/)
    expect(text).toContain('::timestamptz')
    expect(text.indexOf('CASE')).toBeLessThan(text.indexOf('::timestamptz'))
  })

  it('pads a bare year and a year-month to a whole date', () => {
    const text = render(ownGardenDateOn('g'))
    expect(text).toContain("'-01-01'")
    expect(text).toContain("'-01'")
  })

  it('refuses an alias that is not an identifier', () => {
    // This value is interpolated raw. Anything but a plain identifier is a bug
    // at best and an injection at worst.
    for (const bad of ['g; drop table objects', 'G', '1g', '', 'g h', 'g"']) {
      expect(() => ownGardenDateOn(bad)).toThrow(/Unusable SQL alias/)
    }
  })
})

describe('gardenEventAtOn', () => {
  it('prefers the note\'s own date over the derived one', () => {
    // coalesce(own, derived) — the other order would let a book's reading date
    // override what the note says about itself.
    const text = render(gardenEventAtOn('g'))
    expect(text).toMatch(/coalesce\(CASE WHEN g\.note_date/)
    expect(text.indexOf('note_date')).toBeLessThan(text.indexOf('derived_date'))
  })

  it('reads both columns from the given alias', () => {
    const text = render(gardenEventAtOn('gn'))
    expect(text).toContain('gn.note_date')
    expect(text).toContain('gn.derived_date')
  })
})
