import { describe, it, expect } from 'vitest'
import {
  parseIso8601Duration,
  buildVideosListUrl,
  parseVideosListResponse,
  YOUTUBE_VIDEOS_BATCH_SIZE,
  YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL,
} from './fetch-youtube-videos.js'

describe('parseIso8601Duration', () => {
  it('parses the shapes contentDetails actually serves', () => {
    expect(parseIso8601Duration('PT7S')).toBe(7)
    expect(parseIso8601Duration('PT1M30S')).toBe(90)
    expect(parseIso8601Duration('PT9M13S')).toBe(553) // fwLsCgibGw4, Palindrome Ages
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723)
    expect(parseIso8601Duration('PT3M')).toBe(180)
    expect(parseIso8601Duration('P1DT2H')).toBe(93_600)
  })

  it('returns null for a zero total, because a live stream is served as P0D', () => {
    // Load-bearing: a zero here would be a real duration under every era limit, so every
    // livestream in the archive would classify as a Short on a length it does not have.
    expect(parseIso8601Duration('P0D')).toBeNull()
    expect(parseIso8601Duration('PT0S')).toBeNull()
  })

  it('returns null rather than guessing at anything unparseable', () => {
    for (const v of [null, undefined, '', 'PT', '90', 'nonsense', '1M30S']) {
      expect(parseIso8601Duration(v)).toBeNull()
    }
  })
})

describe('buildVideosListUrl', () => {
  it('puts every id in ONE call — this is the whole quota argument', () => {
    // 50 ids per call at 1 unit per call is ~1,846 units for the 92,292-video backlog.
    // One call per video would be 92,292 units, which is nine days of quota.
    const ids = Array.from({ length: YOUTUBE_VIDEOS_BATCH_SIZE }, (_, i) => `id${i}`)
    const url = new URL(buildVideosListUrl(ids, 'KEY'))
    expect(url.searchParams.get('id')?.split(',')).toHaveLength(50)
    expect(YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL).toBe(1)
  })

  it('asks for exactly the two parts classification needs', () => {
    const url = new URL(buildVideosListUrl(['a'], 'KEY'))
    expect(url.searchParams.get('part')).toBe('snippet,contentDetails')
    expect(url.searchParams.get('key')).toBe('KEY')
  })

  it('costs one unit per 50 videos, so the full backlog is ~1,846 units', () => {
    const backlog = 92_292
    const calls = Math.ceil(backlog / YOUTUBE_VIDEOS_BATCH_SIZE)
    expect(calls).toBe(1846)
    expect(calls * YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL).toBeLessThan(10_000)
  })
})

describe('parseVideosListResponse', () => {
  const body = {
    items: [
      {
        id: 'oijqsP5wizI',
        snippet: { publishedAt: '2026-08-01T10:00:00Z', title: 'The best', channelId: 'UCrr', channelTitle: 'Cassie', categoryId: '24' },
        contentDetails: { duration: 'PT7S' },
      },
    ],
  }

  it('maps an item onto the columns it is persisted into', () => {
    const { found } = parseVideosListResponse(['oijqsP5wizI'], body)
    expect(found.get('oijqsP5wizI')).toEqual({
      videoId: 'oijqsP5wizI',
      publishedAt: '2026-08-01T10:00:00Z',
      durationSeconds: 7,
      title: 'The best',
      channelId: 'UCrr',
      channelTitle: 'Cassie',
      categoryId: '24',
    })
  })

  it('derives the missing ids, because the API omits them silently', () => {
    // There is no error and no marker for a deleted or private video — it is simply absent
    // from `items`. Absence IS the signal, and if it were not derived here a dead id would
    // be indistinguishable from one that was never asked about.
    const { found, missing } = parseVideosListResponse(['oijqsP5wizI', 'deletedvid1', 'privatevid'], body)
    expect(found.size).toBe(1)
    expect(missing).toEqual(['deletedvid1', 'privatevid'])
  })

  it('survives a response with no items at all', () => {
    expect(parseVideosListResponse(['a', 'b'], {}).missing).toEqual(['a', 'b'])
    expect(parseVideosListResponse(['a'], { items: null }).found.size).toBe(0)
  })

  it('keeps a video whose duration is unparseable, with a null duration', () => {
    // The metadata is still worth persisting; it just cannot settle the classification.
    const { found } = parseVideosListResponse(['x'], {
      items: [{ id: 'x', snippet: { publishedAt: '2021-01-01T00:00:00Z' }, contentDetails: { duration: 'P0D' } }],
    })
    expect(found.get('x')?.durationSeconds).toBeNull()
    expect(found.get('x')?.publishedAt).toBe('2021-01-01T00:00:00Z')
  })
})
