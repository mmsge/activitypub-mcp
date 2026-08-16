import { describe, it, expect } from 'vitest'
import { and, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { youtubeWatches } from '../../db/schema.js'
import {
  getYoutubeWatchesSchema,
  getYoutubeStatsSchema,
  buildConditions,
  shortsCondition,
  groupPlan,
  rawSecondsExpr,
  cappedSecondsExpr,
  longFormSecondsExpr,
} from './youtube-watches.js'
import { encodeCursor, decodeCursor } from './pagination.js'
import { SHORTS_MAX_SECONDS, WATCH_TIME_CAP_SECONDS } from '../../lib/parse-youtube-takeout.js'

/** Render an expression to SQL text, the way gigs.test.ts asserts on correlations. */
const rendered = (expr: SQL<unknown>): string =>
  getDb().select({ value: expr }).from(youtubeWatches).toSQL().sql

const conditionsSql = (input: Parameters<typeof buildConditions>[0]): string => {
  const c = buildConditions(input)
  return c.length ? rendered(and(...c) as SQL<unknown>) : ''
}

describe('getYoutubeWatchesSchema', () => {
  it('defaults to newest-first, unresolved included, Shorts included', () => {
    const parsed = getYoutubeWatchesSchema.parse({})
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    // Unresolved rows are real watch events. Defaulting them out would make every total
    // silently disagree with the archive.
    expect(parsed.include_unresolved).toBe(true)
    expect(parsed.shorts).toBe('include')
  })

  it('accepts every filter', () => {
    const parsed = getYoutubeWatchesSchema.parse({
      account: 'mvrkws', channel: 'Any Austin', title: 'rivers', video_id: 'hSBFqUUpj8I',
      from: '2025-01-01', to: '2025-12-31', year: 2025,
      shorts: 'only', include_unresolved: false,
      sort_order: 'asc', limit: 200, page: 3,
    })
    expect(parsed).toMatchObject({ account: 'mvrkws', video_id: 'hSBFqUUpj8I', year: 2025, shorts: 'only' })
  })

  it('rejects a limit past the cap and an unknown shorts mode', () => {
    expect(() => getYoutubeWatchesSchema.parse({ limit: 201 })).toThrow()
    expect(() => getYoutubeWatchesSchema.parse({ shorts: 'maybe' })).toThrow()
    expect(() => getYoutubeWatchesSchema.parse({ page: 0 })).toThrow()
  })
})

describe('the from/to bounds', () => {
  // Validated in the schema so a malformed bound is a 400 naming the value, rather than
  // reaching Postgres and coming back as a 500 carrying the whole query.
  it('accepts a date, a datetime, and an ignored timezone suffix', () => {
    for (const v of [
      '2025-01-01',
      '2025-01-01T18:00',
      '2025-01-01T18:00:00',
      '2025-01-01 18:00:00',
      '2025-01-01T18:00:00.5',
      '2025-01-01T18:00:00Z',
      '2025-01-01T18:00:00+02:00',
    ]) {
      expect(getYoutubeWatchesSchema.safeParse({ from: v }).success).toBe(true)
    }
  })

  it('rejects anything that is not a local date or datetime', () => {
    for (const v of ['banana', '', '2025', '01/01/2025', 'now', '2025-01-01T']) {
      expect(getYoutubeWatchesSchema.safeParse({ from: v }).success).toBe(false)
      expect(getYoutubeWatchesSchema.safeParse({ to: v }).success).toBe(false)
    }
  })

  it('says in the message that a timezone suffix is ignored', () => {
    const r = getYoutubeWatchesSchema.safeParse({ from: 'banana' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]!.message).toContain('timezone suffix is ignored')
  })

  it('rejects a year outside any plausible range', () => {
    // YouTube launched in 2005; a four-digit typo should not silently return nothing.
    expect(getYoutubeWatchesSchema.safeParse({ year: 1999 }).success).toBe(false)
    expect(getYoutubeWatchesSchema.safeParse({ year: 20255 }).success).toBe(false)
    expect(getYoutubeWatchesSchema.safeParse({ year: 2025 }).success).toBe(true)
  })
})

describe('getYoutubeStatsSchema', () => {
  it('defaults to a channel ranking', () => {
    const parsed = getYoutubeStatsSchema.parse({})
    expect(parsed.group_by).toBe('channel')
    expect(parsed.limit).toBe(20)
    expect(parsed.include_unresolved).toBe(true)
  })

  it('allows a limit large enough for month buckets', () => {
    // ~190 months span the archive; a cap of 100 would make a full month series
    // impossible to request and quietly truncate it instead.
    expect(getYoutubeStatsSchema.parse({ limit: 500 }).limit).toBe(500)
    expect(() => getYoutubeStatsSchema.parse({ limit: 501 })).toThrow()
  })

  it('offers every group_by the archive needs', () => {
    for (const g of ['channel', 'year', 'month', 'hour_of_day', 'account', 'video']) {
      expect(getYoutubeStatsSchema.parse({ group_by: g }).group_by).toBe(g)
    }
    expect(() => getYoutubeStatsSchema.parse({ group_by: 'weekday' })).toThrow()
  })
})

describe('the time axis', () => {
  // This is the load-bearing invariant of the whole feature: calendar work reads the
  // wall clock, so a bucket is never offset-shifted and can never be double-converted.
  it('filters year on the LOCAL column, not the instant', () => {
    const sql = conditionsSql({ year: 2025 })
    expect(sql).toContain('watched_at_local')
    expect(sql).not.toMatch(/"watched_at"[^_]/)
  })

  it('bounds a year by local midnight to local midnight, half-open', () => {
    const sql = conditionsSql({ year: 2025 })
    // Half-open, so 23:59:59.5 on New Year's Eve belongs to the year it happened in.
    expect(sql).toContain('>=')
    expect(sql).toContain('<')
    expect(sql).toContain('make_timestamp')
  })

  it('filters from/to on the LOCAL column with a ::timestamp cast', () => {
    // The cast is what makes Postgres ignore a caller's offset suffix — the documented
    // contract that these bounds are local wall-clock time.
    const sql = conditionsSql({ from: '2025-01-01', to: '2025-12-31' })
    expect(sql).toContain('watched_at_local')
    expect(sql).toContain('::timestamp')
    expect(sql).not.toContain('::timestamptz')
  })

  it('buckets year, month and hour_of_day on the LOCAL column', () => {
    for (const g of ['year', 'month', 'hour_of_day'] as const) {
      const sql = rendered(groupPlan(g).key as SQL<unknown>)
      expect(sql).toContain('watched_at_local')
      // A bucket read off the instant would need AT TIME ZONE, and applying it twice is
      // the classic way to be an hour out. Reading the local column needs none at all.
      expect(sql).not.toContain('AT TIME ZONE')
    }
  })
})

describe('the Shorts heuristic', () => {
  it('demands a KNOWN sub-threshold duration for "only"', () => {
    const sql = rendered(shortsCondition('only') as SQL<unknown>)
    expect(sql).toContain('IS NOT NULL')
    expect(sql).toContain('<')
  })

  it('KEEPS unknown durations when excluding Shorts', () => {
    // An unknown duration is unknown, not long-form. Dropping those rows would quietly
    // discard ~11% of the archive from every "exclude Shorts" answer.
    const sql = rendered(shortsCondition('exclude') as SQL<unknown>)
    expect(sql).toContain('IS NULL')
    expect(sql).toContain('>=')
  })

  it('adds no condition at all when including everything', () => {
    expect(shortsCondition('include')).toBeNull()
    expect(buildConditions({ shorts: 'include' })).toHaveLength(0)
  })

  it('uses the shared 180-second threshold rather than a local copy', () => {
    expect(SHORTS_MAX_SECONDS).toBe(180)
    expect(rendered(shortsCondition('only') as SQL<unknown>)).toContain('$1')
    const params = getDb().select({ v: shortsCondition('only') as SQL<unknown> }).from(youtubeWatches).toSQL().params
    expect(params).toContain(SHORTS_MAX_SECONDS)
  })
})

describe('buildConditions', () => {
  it('is empty when nothing is filtered, so no WHERE is emitted', () => {
    expect(buildConditions({})).toHaveLength(0)
  })

  it('matches account and video id exactly, channel and title partially', () => {
    expect(conditionsSql({ account: 'mvrkws' })).toContain('=')
    expect(conditionsSql({ video_id: 'hSBFqUUpj8I' })).toContain('=')
    expect(conditionsSql({ channel: 'austin' })).toContain('ilike')
    expect(conditionsSql({ title: 'rivers' })).toContain('ilike')
  })

  it('wraps a partial match in wildcards on both sides', () => {
    const { params } = getDb()
      .select({ v: and(...buildConditions({ channel: 'austin' })) as SQL<unknown> })
      .from(youtubeWatches)
      .toSQL()
    expect(params).toContain('%austin%')
  })

  it('adds an unresolved condition only when explicitly opting out', () => {
    expect(buildConditions({ include_unresolved: true })).toHaveLength(0)
    expect(buildConditions({})).toHaveLength(0)
    expect(buildConditions({ include_unresolved: false })).toHaveLength(1)
  })

  it('combines every filter rather than letting one win', () => {
    expect(buildConditions({
      account: 'mvrkws', channel: 'a', title: 'b', video_id: 'c',
      from: '2025-01-01', to: '2025-12-31', shorts: 'only', include_unresolved: false,
    })).toHaveLength(8)
  })
})

describe('group plans', () => {
  it('ranks channel, video and account by count', () => {
    for (const g of ['channel', 'video', 'account'] as const) {
      expect(groupPlan(g).rankByCount).toBe(true)
    }
  })

  it('returns calendar dimensions in calendar order, not by count', () => {
    // A year list sorted by watch count is not a year list.
    for (const g of ['year', 'month', 'hour_of_day'] as const) {
      expect(groupPlan(g).rankByCount).toBe(false)
    }
  })

  it('excludes channel-less rows from a channel ranking, and only there', () => {
    // They cannot be ranked, so they are dropped from the ranking — and the response
    // reports how many were dropped rather than letting the numbers imply full coverage.
    expect(groupPlan('channel').extra).not.toBeNull()
    expect(rendered(groupPlan('channel').extra as SQL<unknown>)).toContain('channel_id')
    for (const g of ['year', 'month', 'hour_of_day', 'account', 'video'] as const) {
      expect(groupPlan(g).extra).toBeNull()
    }
  })

  it('labels a channel group with its NEWEST name', () => {
    // One id, many names over time: a renamed channel must not appear twice, and the
    // label should be what it calls itself now.
    const sql = rendered(groupPlan('channel').label as SQL<unknown>)
    expect(sql).toContain('array_agg')
    expect(sql).toContain('ORDER BY "watched_at_local" DESC')
  })

  it('groups channels on the id, not the display name', () => {
    expect(rendered(groupPlan('channel').key as SQL<unknown>)).toContain('channel_id')
  })
})

describe('cursor round trip', () => {
  it('survives encode/decode with the instant and the row id', () => {
    const at = new Date('2026-08-16T16:08:00.000Z')
    const id = '10590ad4-6b9f-494f-9fc9-05b93f97d40d'
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ p: at.toISOString(), id })
  })

  it('rejects a token that is not one of ours', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow()
  })
})

describe('the watch-time cap', () => {
  it('is 20 minutes, shared with the parser rather than redeclared', () => {
    // A raw sum counts an eight-hour stream left open for two minutes as eight hours.
    // The cap is a second, differently-wrong figure; quoting both is the honest move.
    expect(WATCH_TIME_CAP_SECONDS).toBe(1200)
  })

  it('guards the capped sum against null durations', () => {
    // Postgres' least() IGNORES nulls instead of propagating them: least(NULL, 1200) is
    // 1200. Without a FILTER, every duration-less row contributes a fabricated 20 minutes
    // — on the real archive that pushed the capped estimate ABOVE the raw one, which
    // cannot happen when least(d, cap) <= d for every row.
    //
    // Asserted on the rendered SQL because these tests never touch a database, and this
    // is precisely the expression whose plain-reading looks correct.
    const capped = cappedSecondsExpr()
    const sql = rendered(capped)
    expect(sql).toContain('least')
    expect(sql).toMatch(/filter\s*\(where[^)]*is not null/i)
  })

  it('leaves the raw and Shorts-excluded sums unguarded, because sum() already ignores nulls', () => {
    // Only least() has the trap. Adding a filter to these would be cargo-culting.
    expect(rendered(rawSecondsExpr())).not.toMatch(/filter/i)
    expect(rendered(longFormSecondsExpr())).toMatch(/filter\s*\(where/i) // by threshold, not nullness
  })
})
