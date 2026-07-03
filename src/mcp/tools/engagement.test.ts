import { describe, it, expect } from 'vitest'
import { buildTrendSeries, type TrendBucketRow } from './engagement.js'

// Latest-per-bucket fixture row; override per case.
function row(partial: Partial<TrendBucketRow>): TrendBucketRow {
  return {
    bucket: '2026-07-01',
    favourites: 0,
    reblogs: 0,
    replies: 0,
    quotes: null,
    sampled_at: '2026-07-01T12:00:00.000Z',
    ...partial,
  }
}

describe('buildTrendSeries', () => {
  it('returns an empty series for an empty window', () => {
    expect(buildTrendSeries([], 'all')).toEqual([])
  })

  it('gives a single bucket null deltas (nothing to diff against)', () => {
    const series = buildTrendSeries([row({ favourites: 3, reblogs: 2 })], 'all')
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      favourites: 3,
      reblogs: 2,
      d_favourites: null,
      d_reblogs: null,
      d_replies: null,
      d_quotes: null,
    })
  })

  it('computes per-bucket deltas across an increasing series', () => {
    const series = buildTrendSeries(
      [
        row({ bucket: '2026-07-01', favourites: 3, reblogs: 2, replies: 0 }),
        row({ bucket: '2026-07-02', favourites: 6, reblogs: 4, replies: 1 }),
        row({ bucket: '2026-07-03', favourites: 7, reblogs: 4, replies: 3 }),
      ],
      'all',
    )
    expect(series[1]).toMatchObject({ d_favourites: 3, d_reblogs: 2, d_replies: 1 })
    expect(series[2]).toMatchObject({ d_favourites: 1, d_reblogs: 0, d_replies: 2 })
  })

  it('preserves negative deltas when counts go down (un-favourite, undo-boost)', () => {
    const series = buildTrendSeries(
      [
        row({ bucket: '2026-07-01', favourites: 6, reblogs: 4 }),
        row({ bucket: '2026-07-02', favourites: 4, reblogs: 1 }),
      ],
      'all',
    )
    expect(series[1]).toMatchObject({ d_favourites: -2, d_reblogs: -3 })
  })

  it('only reports quote deltas when both buckets carry a quote count', () => {
    const series = buildTrendSeries(
      [
        row({ bucket: '2026-07-01', quotes: null }),
        row({ bucket: '2026-07-02', quotes: 2 }),
        row({ bucket: '2026-07-03', quotes: 5 }),
      ],
      'all',
    )
    expect(series[0].d_quotes).toBeNull()
    expect(series[1].d_quotes).toBeNull() // previous bucket had no quote count
    expect(series[2].d_quotes).toBe(3)
  })

  it('emits {value, delta} points for a single metric', () => {
    const series = buildTrendSeries(
      [
        row({ bucket: '2026-07-01', favourites: 3, reblogs: 9 }),
        row({ bucket: '2026-07-02', favourites: 6, reblogs: 9 }),
      ],
      'favourites',
    )
    expect(series[0]).toEqual({
      bucket: '2026-07-01',
      sampled_at: '2026-07-01T12:00:00.000Z',
      value: 3,
      delta: null,
    })
    expect(series[1]).toMatchObject({ value: 6, delta: 3 })
  })

  it('diffs against the previous PRESENT bucket across gaps (no zero-fill)', () => {
    // A day with no snapshots simply doesn't appear; the next bucket's delta
    // spans the gap rather than resetting.
    const series = buildTrendSeries(
      [
        row({ bucket: '2026-07-01', favourites: 3 }),
        row({ bucket: '2026-07-04', favourites: 10 }),
      ],
      'favourites',
    )
    expect(series[1]).toMatchObject({ bucket: '2026-07-04', value: 10, delta: 7 })
  })
})
