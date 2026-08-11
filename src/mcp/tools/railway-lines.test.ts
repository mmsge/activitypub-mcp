import { describe, it, expect } from 'vitest'
import { tripConditions, type TripFilters } from './railway-lines.js'

/**
 * `db.execute(sql`…`)` hands its parameters straight to postgres.js, which throws
 * `ERR_INVALID_ARG_TYPE` on a `Date` — unlike Drizzle's query builder, which
 * serialises them. So a raw-SQL tool that interpolates `new Date(…)` compiles, passes
 * every test that does not set a date filter, and then throws the moment somebody
 * asks for a year.
 *
 * That is exactly how it reached production in `get_trip_weather`: `year`, `from` and
 * `to` all threw there until this was found. These tests walk the built conditions
 * and fail on any `Date` that gets interpolated again.
 */

const base: TripFilters = { include_planned: false }

/** Every interpolated value in a condition, in order. */
function paramsOf(conds: ReturnType<typeof tripConditions>): unknown[] {
  const out: unknown[] = []
  for (const cond of conds) {
    for (const chunk of (cond as unknown as { queryChunks: unknown[] }).queryChunks) {
      // String chunks are the SQL text itself; anything else is an interpolated value.
      if (chunk && chunk.constructor?.name === 'StringChunk') continue
      out.push(chunk)
    }
  }
  return out
}

describe('tripConditions — timestamps never reach postgres.js as Date', () => {
  it('passes the year window as ISO strings', () => {
    const params = paramsOf(tripConditions({ ...base, year: 2025 }))
    expect(params.some((p) => p instanceof Date)).toBe(false)
    expect(params).toContain('2025-01-01T00:00:00.000Z')
    expect(params).toContain('2026-01-01T00:00:00.000Z')
  })

  it('passes an explicit from/to window as ISO strings', () => {
    const params = paramsOf(tripConditions({
      ...base,
      from: '2024-06-01T00:00:00Z',
      to: '2024-06-30T00:00:00Z',
    }))
    expect(params.some((p) => p instanceof Date)).toBe(false)
    expect(params).toContain('2024-06-01T00:00:00.000Z')
    expect(params).toContain('2024-06-30T00:00:00.000Z')
  })

  it('passes no Date for any combination of the filter vocabulary', () => {
    const params = paramsOf(tripConditions({
      include_planned: true,
      journey: 'Kaizershausten 26',
      operator: 'Vygruppen AS',
      station: 'Bergen',
      mode: 'Train',
      status: 'Completed',
      tag: 'togselfie',
      year: 2026,
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    }))
    expect(params.some((p) => p instanceof Date)).toBe(false)
  })

  it('rejects a datetime it cannot parse rather than sending "Invalid Date"', () => {
    expect(() => tripConditions({ ...base, from: 'last Tuesday' })).toThrow(/Invalid datetime/)
  })
})

describe('tripConditions — the departed gate', () => {
  it('gates on departure rather than status by default (ADR 0031)', () => {
    const [first] = tripConditions(base)
    expect(first).toBeDefined()
    // A trip is activity once it has left the platform, so the one currently under
    // way counts and next month's does not.
    expect(JSON.stringify((first as any).queryChunks)).toContain('departure_at <= now()')
  })

  it('drops the gate when planned trips are asked for', () => {
    const conds = tripConditions({ ...base, include_planned: true })
    expect(JSON.stringify(conds.map((c) => (c as any).queryChunks))).not.toContain('now()')
  })

  it('applies the status filter independently of the gate', () => {
    // status is the export's own word; it is not what decides the default totals.
    const conds = tripConditions({ ...base, status: 'Planned' })
    expect(paramsOf(conds)).toContain('Planned')
  })
})
