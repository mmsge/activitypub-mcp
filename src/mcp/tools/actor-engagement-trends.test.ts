import { describe, it, expect } from 'vitest'
import {
  metricStats,
  buildActorTrendSeries,
  type ActorTrendBucketRow,
} from './actor-engagement-trends.js'

const stat = (p: Partial<{ sum: number; min: number; max: number; mean: number; median: number }>) => ({
  sum: 0, min: 0, max: 0, mean: 0, median: 0, ...p,
})

function bucket(partial: Partial<ActorTrendBucketRow>): ActorTrendBucketRow {
  return {
    bucket: '2026-01-01',
    post_count: 1,
    favourites: stat({}),
    reblogs: stat({}),
    replies: stat({}),
    ...partial,
  }
}

const noOverall = {
  favourites: { sum: 0, mean: 0 },
  reblogs: { sum: 0, mean: 0 },
  replies: { sum: 0, mean: 0 },
}

describe('metricStats', () => {
  const s = stat({ sum: 13, min: 4, max: 9, mean: 6.5, median: 6 })

  it('picks the mean as value and rounds to 2 dp', () => {
    expect(metricStats('mean', stat({ sum: 10, min: 1, max: 9, mean: 3.333333, median: 3 })))
      .toEqual({ value: 3.33, sum: 10, min: 1, max: 9 })
  })

  it('picks sum / max / median for the respective aggregate', () => {
    expect(metricStats('sum', s).value).toBe(13)
    expect(metricStats('max', s).value).toBe(9)
    expect(metricStats('median', s).value).toBe(6)
  })

  it('always surfaces sum/min/max regardless of aggregate', () => {
    expect(metricStats('max', s)).toEqual({ value: 9, sum: 13, min: 4, max: 9 })
  })
})

describe('buildActorTrendSeries', () => {
  it('returns an empty series and zeroed summary for no buckets', () => {
    const { series, summary } = buildActorTrendSeries([], 'favourites', 'mean', noOverall, 0)
    expect(series).toEqual([])
    expect(summary).toEqual({ posts: 0, overall_mean: 0, overall_sum: 0 })
  })

  it('emits {bucket, post_count, value, sum, min, max} for a single metric', () => {
    const rows = [
      bucket({ bucket: '2026-01-01', post_count: 2, favourites: stat({ sum: 13, min: 4, max: 9, mean: 6.5, median: 6.5 }) }),
      bucket({ bucket: '2026-01-02', post_count: 1, favourites: stat({ sum: 11, min: 11, max: 11, mean: 11, median: 11 }) }),
    ]
    const { series } = buildActorTrendSeries(rows, 'favourites', 'mean', noOverall, 3)
    expect(series[0]).toEqual({ bucket: '2026-01-01', post_count: 2, value: 6.5, sum: 13, min: 4, max: 9 })
    expect(series[1]).toEqual({ bucket: '2026-01-02', post_count: 1, value: 11, sum: 11, min: 11, max: 11 })
  })

  it('honours the aggregate when choosing value (sum → total reach)', () => {
    const rows = [bucket({ post_count: 2, favourites: stat({ sum: 13, min: 4, max: 9, mean: 6.5 }) })]
    const { series } = buildActorTrendSeries(rows, 'favourites', 'sum', noOverall, 2)
    expect(series[0]).toMatchObject({ value: 13 })
  })

  it('nests one stat object per metric when metric=all', () => {
    const rows = [
      bucket({
        bucket: '2026-01-01',
        post_count: 2,
        favourites: stat({ sum: 13, min: 4, max: 9, mean: 6.5 }),
        reblogs: stat({ sum: 4, min: 1, max: 3, mean: 2 }),
        replies: stat({ sum: 2, min: 0, max: 2, mean: 1 }),
      }),
    ]
    const { series } = buildActorTrendSeries(rows, 'all', 'mean', noOverall, 2)
    expect(series[0]).toEqual({
      bucket: '2026-01-01',
      post_count: 2,
      favourites: { value: 6.5, sum: 13, min: 4, max: 9 },
      reblogs: { value: 2, sum: 4, min: 1, max: 3 },
      replies: { value: 1, sum: 2, min: 0, max: 2 },
    })
  })

  it('reports window-level overall_mean/overall_sum over sampled posts', () => {
    const { summary } = buildActorTrendSeries(
      [],
      'favourites',
      'mean',
      { favourites: { sum: 4301, mean: 8.6365 }, reblogs: { sum: 0, mean: 0 }, replies: { sum: 0, mean: 0 } },
      512,
    )
    expect(summary).toEqual({ posts: 512, overall_mean: 8.64, overall_sum: 4301 })
  })

  it('gives a per-metric summary when metric=all', () => {
    const { summary } = buildActorTrendSeries(
      [],
      'all',
      'mean',
      { favourites: { sum: 100, mean: 5 }, reblogs: { sum: 20, mean: 1 }, replies: { sum: 8, mean: 0.4 } },
      20,
    )
    expect(summary).toEqual({
      posts: 20,
      favourites: { overall_mean: 5, overall_sum: 100 },
      reblogs: { overall_mean: 1, overall_sum: 20 },
      replies: { overall_mean: 0.4, overall_sum: 8 },
    })
  })
})
