import { describe, it, expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { and, type SQL } from 'drizzle-orm'
import { osloDay } from '../../stream/event-date.js'
import { UnknownTimeZoneError } from '../../lib/scrobble-timeline.js'

// Nothing here may open a connection: this repo has no test database, so a tool test
// asserts on the SQL it would have sent. Same guard as scrobble-race.test.ts.
const getDb = vi.fn(() => {
  throw new Error('scrobble-timeline tests must not touch the database')
})
vi.mock('../../db/client.js', () => ({ getDb }))

const {
  localBucketExpr, localWindowConditions,
  getScrobbleTimelineSchema, getScrobbleTimelineRestSchema,
  getScrobbleTimeline,
} = await import('./scrobble-timeline.js')
const { endpoints } = await import('../../rest/table.js')
const { coerceQuery } = await import('../../rest/coerce.js')

// Shape assertions only — what these expressions actually DO is verified by running
// them against Postgres (see the PR body), the same division garden-date-sql.test.ts
// documents. What is pinned here is what a refactor could quietly break without any
// query failing.
const dialect = new PgDialect()
const render = (s: SQL) => dialect.sqlToQuery(s)

describe('the local day is the day he lived', () => {
  it('is a different calendar day in summer than UTC says', () => {
    // The hazard the SQL has to reproduce. Norway is UTC+2 in summer, so a play at
    // 21:30Z on 30 June is 23:30 on the 30th locally — but push it half an hour later
    // and the local day has turned while the UTC one has not. In January the same
    // wall clock is still the same day in both.
    expect(osloDay(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01')
    expect(new Date('2026-06-30T22:30:00Z').toISOString().slice(0, 10)).toBe('2026-06-30')
    expect(osloDay(new Date('2026-01-30T22:30:00Z'))).toBe('2026-01-30')
    // Bucketing on the UTC date would misfile every late-evening summer play by a day,
    // and an aggregate gives no hint that it happened.
  })
})

describe('localBucketExpr', () => {
  it('converts to local time BEFORE truncating', () => {
    const { sql } = render(localBucketExpr('day', 'Europe/Oslo'))
    expect(sql).toContain('AT TIME ZONE')
    expect(sql).toContain('date_trunc')
    expect(sql).toContain("'YYYY-MM-DD'")
    // date_trunc( … AT TIME ZONE … ) and not the other way round: truncating the UTC
    // instant first and shifting afterwards would move the boundary, not the label.
    expect(sql.indexOf('date_trunc')).toBeLessThan(sql.indexOf('AT TIME ZONE'))
    expect(sql).toMatch(/date_trunc\(\$\d+, \("scrobbles"\."played_at" AT TIME ZONE \$\d+\)\)/)
  })

  it('BINDS the timezone instead of interpolating it', () => {
    // `timezone` is caller-supplied text reaching a SQL expression. If it ever appears
    // in the statement itself rather than the parameter list, this is an injection.
    const evil = "Europe/Oslo'; DROP TABLE scrobbles; --"
    const { sql, params } = render(localBucketExpr('day', evil))
    expect(params).toContain(evil)
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).not.toContain('Europe/Oslo')

    const { sql: plain, params: plainParams } = render(localBucketExpr('month', 'Europe/Oslo'))
    expect(plainParams).toContain('Europe/Oslo')
    expect(plainParams).toContain('month')
    expect(plain).not.toContain('Europe/Oslo')
    expect(plain).not.toContain('month')
  })
})

describe('localWindowConditions', () => {
  it('bounds the indexed column, not the converted expression', () => {
    // A predicate on `played_at AT TIME ZONE $1` could not use scrobbles_played_idx,
    // so the local dates are converted back to instants instead.
    const { sql, params } = render(and(...localWindowConditions('2026-06-28', '2026-07-02', 'Europe/Oslo'))!)
    expect(sql).toContain('"scrobbles"."played_at" >=')
    expect(sql).toContain('"scrobbles"."played_at" <')
    expect(params).toEqual(['2026-06-28', 'Europe/Oslo', '2026-07-02', 'Europe/Oslo'])
  })

  it('makes an inclusive `to` exclusive on the following local midnight', () => {
    // `to` names a whole day, so the upper bound is the next midnight — the same rule
    // parseWatchedBound already states for get_watched.
    const { sql } = render(and(...localWindowConditions('2026-06-28', '2026-07-02', 'Europe/Oslo'))!)
    expect(sql).toContain('::date + 1')
    expect(sql).not.toContain('<=')
  })
})

describe('the two schemas', () => {
  it('defaults MCP to a monthly, top-12 answer', () => {
    // A bare MCP call must be readable in a chat context; the full daily series with
    // every entity is 3,894 buckets and ~1.2 MB; these defaults are ~41 KB.
    expect(getScrobbleTimelineSchema.parse({})).toEqual({
      bucket: 'month',
      top_n: 12,
      group_by: 'artist',
      min_plays: 1,
      timezone: 'Europe/Oslo',
      include_empty_buckets: true,
    })
  })

  it('defaults REST to the whole daily series', () => {
    expect(getScrobbleTimelineRestSchema.parse({})).toMatchObject({ bucket: 'day', top_n: 0 })
  })

  it('differs from MCP in those two defaults and nothing else', () => {
    // The one divergence between the surfaces. Pinned in both directions so a refactor
    // that unifies the schemas fails here rather than quietly changing a bare call.
    const mcp = getScrobbleTimelineSchema.parse({}) as Record<string, unknown>
    const rest = getScrobbleTimelineRestSchema.parse({}) as Record<string, unknown>
    const differing = Object.keys(mcp).filter((k) => mcp[k] !== rest[k])
    expect(differing.sort()).toEqual(['bucket', 'top_n'])
    expect(Object.keys(getScrobbleTimelineSchema.shape).sort())
      .toEqual(Object.keys(getScrobbleTimelineRestSchema.shape).sort())
  })

  it('parses the same explicit input identically on both surfaces', () => {
    const input = { bucket: 'week' as const, top_n: 5, group_by: 'album' as const, timezone: 'UTC' }
    expect(getScrobbleTimelineSchema.parse(input)).toEqual(getScrobbleTimelineRestSchema.parse(input))
  })

  it('rejects a malformed timezone before a connection is opened', () => {
    // Through REST this is the 400 from router.ts's safeParse. The schema checks the
    // SHAPE only — which zones exist is knowable only by asking Postgres, so a
    // shaped-but-unknown zone is refused later, by the handler, as an
    // UnknownTimeZoneError that router.ts also maps to 400.
    const bad = getScrobbleTimelineSchema.safeParse({ timezone: 'not a zone' })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toContain('IANA')
    expect(getScrobbleTimelineSchema.safeParse({ timezone: 'Europe/Oslo' }).success).toBe(true)
    expect(getScrobbleTimelineSchema.safeParse({ timezone: 'America/Argentina/Buenos_Aires' }).success).toBe(true)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('names the zone, and the links, when Postgres does not know it', () => {
    // The message has to say more than "invalid": US/Pacific is a real zone name that
    // ICU accepts and this Postgres does not, so a caller who pasted it needs telling
    // which spelling to use rather than being told they imagined it.
    const err = new UnknownTimeZoneError('US/Pacific')
    expect(err.message).toContain('US/Pacific')
    expect(err.message).toContain('Europe/Oslo')
    expect(err.message).toMatch(/backward-compatibility/)
  })

  it('reduces a from/to bound to its calendar date and refuses a malformed one', () => {
    // A time of day cannot narrow a whole-day bucket, so it is accepted and dropped
    // rather than rejected — a pasted ISO timestamp should not be an error.
    expect(getScrobbleTimelineSchema.parse({ from: '2026-06-30T22:30:00Z' }).from).toBe('2026-06-30')
    expect(getScrobbleTimelineSchema.parse({ to: ' 2026-07-02 ' }).to).toBe('2026-07-02')
    expect(getScrobbleTimelineSchema.safeParse({ from: '30 June 2026' }).success).toBe(false)
    expect(getScrobbleTimelineSchema.safeParse({ from: '2026-6-3' }).success).toBe(false)
  })

  it('bounds the numeric parameters', () => {
    expect(getScrobbleTimelineSchema.safeParse({ top_n: -1 }).success).toBe(false)
    expect(getScrobbleTimelineSchema.safeParse({ top_n: 0 }).success).toBe(true)
    expect(getScrobbleTimelineSchema.safeParse({ min_plays: 0 }).success).toBe(false)
    expect(getScrobbleTimelineSchema.safeParse({ bucket: 'year' }).success).toBe(false)
  })
})

describe('the REST endpoint', () => {
  const entry = endpoints.find((e) => e.path === '/scrobble-timeline')

  it('is registered against the REST schema and the shared handler', () => {
    expect(entry).toBeDefined()
    expect(entry!.name).toBe('get_scrobble_timeline')
    expect(entry!.schema).toBe(getScrobbleTimelineRestSchema)
    // Unwrapped: publicOnly pins endpoints that serve POST rows, and a scrobble is not
    // one — there is no visibility to narrow here.
    expect(entry!.handler).toBe(getScrobbleTimeline)
  })

  it('declares every parameter that needs coercing out of a query string', () => {
    // A GET arrives as strings and the schemas use z.number()/z.boolean(), not
    // z.coerce.*, so anything missing from these lists is a guaranteed 400. Driven
    // through the real coercion layer rather than inspected, so the test fails for the
    // same reason a request would.
    expect(entry!.numbers.sort()).toEqual(['min_plays', 'top_n'])
    expect(entry!.booleans).toEqual(['include_empty_buckets'])

    const query: Record<string, string[]> = {
      bucket: ['week'], group_by: ['album'], top_n: ['5'], min_plays: ['2'],
      timezone: ['UTC'], include_empty_buckets: ['false'],
      from: ['2026-01-01'], to: ['2026-02-01'],
      artist: ['maisie'], album: ['witch'], track: ['labour'],
    }
    const parsed = getScrobbleTimelineRestSchema.safeParse(coerceQuery(query, entry!))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({
      bucket: 'week', group_by: 'album', top_n: 5, min_plays: 2,
      timezone: 'UTC', include_empty_buckets: false,
      from: '2026-01-01', to: '2026-02-01',
      artist: 'maisie', album: 'witch', track: 'labour',
    })
    // Every declared parameter is exercised above, so a new one added to the schema
    // without a coercion entry shows up here as an unparsed string.
    expect(Object.keys(query).sort()).toEqual(Object.keys(getScrobbleTimelineRestSchema.shape).sort())
  })
})
