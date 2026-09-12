import { describe, it, expect } from 'vitest'
import {
  MAX_BUCKETS, OTHER_KEY,
  assembleTimeline, bucketKeys, bucketStart, entityKey, foldBucket, foldKeyFor,
  isTimeZoneShaped, nextBucketKey, pickTop, resolveRange,
  type EntityRow, type FlatRow,
} from './scrobble-timeline.js'

// Pure module — no database, no mocks. Everything the timeline decides beyond the
// GROUP BY itself is decided here, which is what makes it testable at all: this repo
// has no test database (vitest.config.ts points DATABASE_URL at a placeholder).

const totals = (pairs: Array<[string, number]>) => new Map(pairs)

describe('bucket key arithmetic', () => {
  it('steps a day, including across month and leap-year boundaries', () => {
    expect(nextBucketKey('2026-09-11', 'day')).toBe('2026-09-12')
    expect(nextBucketKey('2026-01-31', 'day')).toBe('2026-02-01')
    expect(nextBucketKey('2024-02-28', 'day')).toBe('2024-02-29')
    expect(nextBucketKey('2024-02-29', 'day')).toBe('2024-03-01')
    expect(nextBucketKey('2026-02-28', 'day')).toBe('2026-03-01')
    expect(nextBucketKey('2026-12-31', 'day')).toBe('2027-01-01')
  })

  it('rebuilds a month rather than adding one', () => {
    // `setUTCMonth(+1)` from the 31st overflows into the month after next. Month keys
    // are always the 1st, so a long-month sequence must not skip February.
    expect(nextBucketKey('2026-01-01', 'month')).toBe('2026-02-01')
    expect(nextBucketKey('2026-01-31', 'month')).toBe('2026-02-01')
    expect(nextBucketKey('2026-12-01', 'month')).toBe('2027-01-01')
  })

  it('keys a week on its Monday, matching date_trunc(\'week\')', () => {
    // 2026-09-12 is a Saturday; 2026-09-13 a Sunday, which belongs to the week before.
    expect(bucketStart('2026-09-12', 'week')).toBe('2026-09-07')
    expect(bucketStart('2026-09-13', 'week')).toBe('2026-09-07')
    expect(bucketStart('2026-09-14', 'week')).toBe('2026-09-14')
    expect(nextBucketKey('2026-09-07', 'week')).toBe('2026-09-14')
  })

  it('normalises a date to its bucket', () => {
    expect(bucketStart('2026-09-12', 'day')).toBe('2026-09-12')
    expect(bucketStart('2026-09-12', 'month')).toBe('2026-09-01')
  })

  it('refuses a date that is not real, rather than rolling it over', () => {
    // Date.UTC(2026, 1, 30) is 2 March. Accepting it would answer a question that was
    // not asked, with no error anywhere.
    expect(() => bucketStart('2026-02-30', 'day')).toThrow(/Not a real date/)
    expect(() => bucketStart('2026-13-01', 'day')).toThrow(/Not a real date/)
    expect(() => bucketStart('12 September 2026', 'day')).toThrow(/Not a bucket key/)
    expect(() => bucketStart('2026-09-12T10:00:00Z', 'day')).toThrow(/Not a bucket key/)
  })

  it('enumerates every bucket in the range, inclusive of both ends', () => {
    expect(bucketKeys('2026-09-10', '2026-09-13', 'day'))
      .toEqual(['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'])
    expect(bucketKeys('2026-09-12', '2026-09-12', 'day')).toEqual(['2026-09-12'])
    expect(bucketKeys('2026-11-15', '2027-02-03', 'month'))
      .toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'])
    expect(bucketKeys('2026-09-12', '2026-09-30', 'week'))
      .toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
  })

  it('has a defensive ceiling', () => {
    // Unreachable in practice — resolveRange clamps to the archive's own bounds first —
    // so hitting it means the clamping broke, not that a caller asked for too much.
    expect(() => bucketKeys('1000-01-01', '2026-01-01', 'day')).toThrow(RangeError)
    expect(bucketKeys('1000-01-01', '2026-01-01', 'month').length).toBeLessThan(MAX_BUCKETS)
  })
})

describe('resolveRange', () => {
  const bounds = { min: '2016-01-15', max: '2026-09-12', today: '2026-09-12' }

  it('pulls a wide-open lower bound forward to the archive start', () => {
    // The alternative is 116 years of pre-Last.fm silence, which is why there is no
    // user-facing range limit to trip over.
    expect(resolveRange(bounds, { from: '1900-01-01' })).toEqual({ from: '2016-01-15', to: '2026-09-12' })
    expect(resolveRange(bounds, {})).toEqual({ from: '2016-01-15', to: '2026-09-12' })
  })

  it('honours a narrower request', () => {
    expect(resolveRange(bounds, { from: '2020-01-01', to: '2020-12-31' }))
      .toEqual({ from: '2020-01-01', to: '2020-12-31' })
  })

  it('pushes the upper bound back to today, never emitting the future as silence', () => {
    expect(resolveRange(bounds, { to: '2030-01-01' })?.to).toBe('2026-09-12')
  })

  it('does not clamp to the last day WITH data — trailing silence is the answer', () => {
    // "Has he stopped listening?" is answered by zero buckets at the end, so `to`
    // follows the clock rather than the data.
    const quiet = { min: '2016-01-15', max: '2026-09-01', today: '2026-09-12' }
    expect(resolveRange(quiet, {})?.to).toBe('2026-09-12')
  })

  it('is null for an empty archive or a crossed-over window', () => {
    expect(resolveRange({ min: null, max: null, today: '2026-09-12' }, {})).toBeNull()
    expect(resolveRange(bounds, { from: '2026-09-10', to: '2026-09-01' })).toBeNull()
  })
})

describe('entityKey', () => {
  it('is the bare name for an artist and carries the artist otherwise', () => {
    // get_scrobble_stats groups tracks by (artist, track) so same-titled songs by
    // different artists do not merge; a timeline keyed on bare names would undo that.
    expect(entityKey('artist', 'Paris Paloma', 'Paris Paloma')).toBe('Paris Paloma')
    expect(entityKey('track', 'Paris Paloma', 'labour')).toBe('Paris Paloma – labour')
    expect(entityKey('track', 'Snow Patrol', 'Run')).not.toBe(entityKey('track', 'Leona Lewis', 'Run'))
  })

  it('names a missing album rather than dropping the scrobble', () => {
    // Last.fm files plenty of singles with no album. Dropping them would make the
    // bucket totals disagree with the real scrobble count.
    expect(entityKey('album', 'Maisie Peters', null)).toBe('Maisie Peters – (unknown)')
  })
})

describe('foldKeyFor', () => {
  it('is "Other" when nothing is called that', () => {
    expect(foldKeyFor(['Maisie Peters', 'Paris Paloma'])).toBe(OTHER_KEY)
  })

  it('steps aside for a real entity of that name', () => {
    // Silently merging an actual artist into the overflow row is undetectable from the
    // response, so the key moves and the envelope reports where it went.
    expect(foldKeyFor(['Other', 'Maisie Peters'])).toBe('Other (folded)')
    expect(foldKeyFor(['Other', 'Other (folded)'])).toBe('Other (folded 2)')
  })
})

describe('foldBucket', () => {
  const rangePlays = totals([['A', 100], ['B', 90], ['C', 80], ['D', 70], ['E', 60]])

  it('caps at top_n and sums the overflow into the fold key', () => {
    const raw = totals([['A', 10], ['B', 8], ['C', 6], ['D', 3], ['E', 1]])
    expect(foldBucket(raw, { topN: 3, minPlays: 1, foldKey: OTHER_KEY, rangePlays }))
      .toEqual({ A: 10, B: 8, C: 6, Other: 4 })
  })

  it('folds nothing at top_n 0', () => {
    const raw = totals([['A', 10], ['B', 8]])
    expect(foldBucket(raw, { topN: 0, minPlays: 1, foldKey: OTHER_KEY, rangePlays }))
      .toEqual({ A: 10, B: 8 })
  })

  it('omits the fold key when nothing overflows', () => {
    const raw = totals([['A', 10], ['B', 8]])
    expect(foldBucket(raw, { topN: 5, minPlays: 1, foldKey: OTHER_KEY, rangePlays }))
      .toEqual({ A: 10, B: 8 })
  })

  it('DROPS below min_plays rather than folding it', () => {
    // min_plays exists to remove the long tail. Folding it would put the whole tail
    // straight back as one large bar, which is the opposite of what was asked.
    const raw = totals([['A', 10], ['B', 8], ['C', 1], ['D', 1]])
    expect(foldBucket(raw, { topN: 0, minPlays: 2, foldKey: OTHER_KEY, rangePlays }))
      .toEqual({ A: 10, B: 8 })
  })

  it('orders plays-descending, so JSON insertion order is useful', () => {
    const raw = totals([['C', 6], ['A', 10], ['B', 8]])
    expect(Object.keys(foldBucket(raw, { topN: 0, minPlays: 1, foldKey: OTHER_KEY, rangePlays })))
      .toEqual(['A', 'B', 'C'])
  })

  it('breaks a cap-boundary tie by range-wide plays, then by key', () => {
    // Which of two entities on 8 plays each survives a top_n of 2 must not depend on
    // row order out of Postgres.
    const raw = totals([['C', 8], ['B', 8], ['A', 10]])
    expect(foldBucket(raw, { topN: 2, minPlays: 1, foldKey: OTHER_KEY, rangePlays }))
      .toEqual({ A: 10, B: 8, Other: 8 })
    const flat = totals([['Y', 5], ['X', 5]])
    expect(Object.keys(foldBucket(flat, { topN: 1, minPlays: 1, foldKey: OTHER_KEY, rangePlays: totals([]) })))
      .toEqual(['X', OTHER_KEY])
  })
})

describe('pickTop', () => {
  it('is the entity with the most plays in the bucket', () => {
    expect(pickTop(totals([['A', 3], ['B', 24], ['C', 14]]), totals([]))).toBe('B')
  })

  it('is null for a silent bucket', () => {
    expect(pickTop(totals([]), totals([]))).toBeNull()
  })

  it('breaks a tie by range-wide plays, then alphabetically', () => {
    const tied = totals([['Paris Paloma', 12], ['Maisie Peters', 12]])
    expect(pickTop(tied, totals([['Paris Paloma', 812], ['Maisie Peters', 11029]])))
      .toBe('Maisie Peters')
    // Equal on both counts: byte-wise on the key, so the answer is stable between
    // calls and between machines (localeCompare is neither).
    expect(pickTop(tied, totals([['Paris Paloma', 5], ['Maisie Peters', 5]])))
      .toBe('Maisie Peters')
    expect(pickTop(totals([['b', 1], ['A', 1]]), totals([]))).toBe('A')
  })

  it('does not depend on input order', () => {
    const rangePlays = totals([['A', 10], ['B', 10]])
    const forwards = pickTop(totals([['A', 5], ['B', 5]]), rangePlays)
    const backwards = pickTop(totals([['B', 5], ['A', 5]]), rangePlays)
    expect(forwards).toBe(backwards)
  })
})

describe('assembleTimeline', () => {
  const entities: EntityRow[] = [
    { key: 'Maisie Peters', name: 'Maisie Peters', artist: 'Maisie Peters', plays: 30, image: 'https://img/mp' },
    { key: 'Paris Paloma', name: 'Paris Paloma', artist: 'Paris Paloma', plays: 12, image: null },
    { key: 'Sabrina Carpenter', name: 'Sabrina Carpenter', artist: 'Sabrina Carpenter', plays: 5, image: 'https://img/sc' },
  ]
  const rows: FlatRow[] = [
    { bucket: '2026-09-08', key: 'Maisie Peters', plays: 20 },
    { bucket: '2026-09-08', key: 'Paris Paloma', plays: 10 },
    { bucket: '2026-09-08', key: 'Sabrina Carpenter', plays: 1 },
    // 09-09 through 09-11 silent — a real gap in the listening history.
    { bucket: '2026-09-12', key: 'Maisie Peters', plays: 10 },
    { bucket: '2026-09-12', key: 'Paris Paloma', plays: 2 },
    { bucket: '2026-09-12', key: 'Sabrina Carpenter', plays: 4 },
  ]
  const base = {
    bucket: 'day' as const,
    groupBy: 'artist' as const,
    timezone: 'Europe/Oslo',
    range: { from: '2026-09-08', to: '2026-09-12' },
    rows,
    entities,
    topN: 0,
    minPlays: 1,
    includeEmptyBuckets: true,
    filters: { artist: null, album: null, track: null },
  }

  it('emits the silent buckets as genuine zeroes', () => {
    // A week of not listening is signal, not missing data — and a client that had to
    // reconstruct the gaps would be reimplementing the enumeration.
    const out = assembleTimeline(base)
    expect(out.buckets.map((b) => b.date))
      .toEqual(['2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08'])
    expect(out.buckets[1]).toEqual({ date: '2026-09-11', plays: 0, top: null, entities: {} })
    expect(out.totals.buckets).toBe(5)
    expect(out.totals.active_buckets).toBe(2)
  })

  it('drops the silent buckets on request without losing count of them', () => {
    const out = assembleTimeline({ ...base, includeEmptyBuckets: false })
    expect(out.buckets.map((b) => b.date)).toEqual(['2026-09-12', '2026-09-08'])
    expect(out.totals.buckets).toBe(5)
    expect(out.totals.active_buckets).toBe(2)
  })

  it('precomputes the winner of each bucket', () => {
    const out = assembleTimeline(base)
    expect(out.buckets.map((b) => b.top)).toEqual(['Maisie Peters', null, null, null, 'Maisie Peters'])
  })

  it('picks `top` from the raw counts, so a display parameter cannot change it', () => {
    // top_n 1 shows one artist plus the fold; `top` must still be the real winner and
    // must never be the fold key, whose total can outrank every individual entity.
    const capped = assembleTimeline({ ...base, topN: 1 })
    expect(capped.buckets[0].entities).toEqual({ 'Maisie Peters': 10, Other: 6 })
    expect(capped.buckets[0].top).toBe('Maisie Peters')
    expect(assembleTimeline(base).buckets.map((b) => b.top))
      .toEqual(capped.buckets.map((b) => b.top))
  })

  it('keeps `plays` the true bucket total when min_plays drops a tail', () => {
    const out = assembleTimeline({ ...base, minPlays: 5 })
    const newest = out.buckets[0]
    expect(newest.plays).toBe(16) // 10 + 2 + 4, all of it
    expect(newest.entities).toEqual({ 'Maisie Peters': 10 })
    // Documented: entities sums to less than plays exactly when min_plays drops rows.
    // A `plays` that moved with min_plays would make two calls incomparable.
    const shown = Object.values(newest.entities).reduce((a, b) => a + b, 0)
    expect(shown).toBeLessThan(newest.plays)
  })

  it('sums to plays exactly when nothing is dropped, folded or not', () => {
    for (const topN of [0, 1, 2, 3, 50]) {
      for (const bucket of assembleTimeline({ ...base, topN }).buckets) {
        const shown = Object.values(bucket.entities).reduce((a, b) => a + b, 0)
        expect(shown).toBe(bucket.plays)
      }
    }
  })

  it('hoists entity metadata out of the buckets, ordered by plays', () => {
    const out = assembleTimeline(base)
    expect(Object.keys(out.entities)).toEqual(['Maisie Peters', 'Paris Paloma', 'Sabrina Carpenter'])
    expect(out.entities['Maisie Peters']).toEqual({
      plays: 30, image: 'https://img/mp', artist: 'Maisie Peters', name: 'Maisie Peters',
    })
    expect(out.totals).toMatchObject({ scrobbles: 47, distinct_artists: 3, distinct_entities: 3 })
  })

  it('lists every entity at top_n 0 — the chart needs them all to anchor colours', () => {
    const out = assembleTimeline({ ...base, topN: 0 })
    expect(Object.keys(out.entities)).toHaveLength(3)
  })

  it('drops an entity that every bucket folds away, but still counts it', () => {
    // Carrying the whole range-wide set regardless of top_n was 262 KB of the monthly
    // top-12 answer's 275 KB, against a default whose only job is to fit in a chat
    // context. An entity no bucket shows is invisible in the series anyway.
    const out = assembleTimeline({ ...base, topN: 1 })
    expect(Object.keys(out.entities)).toEqual(['Maisie Peters'])
    expect(out.entities['Sabrina Carpenter']).toBeUndefined()
    // The totals still describe the whole range, not the part that fitted.
    expect(out.totals).toMatchObject({ scrobbles: 47, distinct_artists: 3, distinct_entities: 3 })
  })

  it('reports the fold key it actually used', () => {
    const shadowed: EntityRow[] = [
      ...entities,
      { key: 'Other', name: 'Other', artist: 'Other', plays: 2, image: null },
    ]
    const out = assembleTimeline({
      ...base,
      entities: shadowed,
      rows: [...rows, { bucket: '2026-09-12', key: 'Other', plays: 2 }],
      topN: 2,
    })
    expect(out.other_key).toBe('Other (folded)')
    expect(out.buckets[0].entities).toEqual({ 'Maisie Peters': 10, 'Sabrina Carpenter': 4, 'Other (folded)': 4 })
  })

  it('answers an empty archive without inventing a range', () => {
    const out = assembleTimeline({ ...base, range: null, rows: [], entities: [] })
    expect(out.range).toEqual({ from: null, to: null })
    expect(out.buckets).toEqual([])
    expect(out.totals).toEqual({
      buckets: 0, active_buckets: 0, scrobbles: 0, distinct_artists: 0, distinct_entities: 0,
    })
  })

  it('counts distinct artists separately from distinct entities', () => {
    // The field is named for artists, so it means artists whatever group_by is: two
    // albums by one artist are one artist and two entities.
    const albums: EntityRow[] = [
      { key: 'Maisie Peters – The Good Witch', name: 'The Good Witch', artist: 'Maisie Peters', plays: 20, image: null },
      { key: 'Maisie Peters – Lost The Breakup', name: 'Lost The Breakup', artist: 'Maisie Peters', plays: 10, image: null },
    ]
    const out = assembleTimeline({
      ...base,
      groupBy: 'album',
      entities: albums,
      rows: albums.map((e) => ({ bucket: '2026-09-12', key: e.key, plays: e.plays })),
    })
    expect(out.totals.distinct_artists).toBe(1)
    expect(out.totals.distinct_entities).toBe(2)
  })
})

describe('isTimeZoneShaped', () => {
  it('accepts the shapes a zone name comes in', () => {
    // A shape gate, not an authority: which zones EXIST is only knowable by asking
    // Postgres, and the handler does. This keeps obvious junk from opening a
    // connection and keeps the error message about the parameter.
    for (const tz of [
      'Europe/Oslo', 'UTC', 'America/New_York', 'America/Argentina/Buenos_Aires',
      'Etc/GMT+5', 'Asia/Ho_Chi_Minh', 'US/Pacific',
    ]) {
      expect(isTimeZoneShaped(tz)).toBe(true)
    }
  })

  it('refuses junk without asking the database', () => {
    for (const tz of [
      '', ' Europe/Oslo', 'Europe/Oslo ', 'not a zone', "Europe/Oslo'; drop table scrobbles; --",
      '/Oslo', 'Europe//Oslo', 'a/b/c/d', 'Europe/Oslo\n', 'x'.repeat(65),
    ]) {
      expect(isTimeZoneShaped(tz)).toBe(false)
    }
  })

  it('is deliberately NOT Intl-backed', () => {
    // Neither Intl set matches Postgres. `Intl.DateTimeFormat` accepts 18 backward
    // links this Postgres rejects, and `supportedValuesOf` omits 99 it accepts — so a
    // shaped-but-unknown zone like US/Pacific passes HERE and is refused by the
    // handler against pg_timezone_names, with a 400 either way.
    expect(isTimeZoneShaped('US/Pacific')).toBe(true)
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('US/Pacific')
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('America/Argentina/Buenos_Aires')
  })
})
