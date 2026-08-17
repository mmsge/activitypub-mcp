import { describe, it, expect } from 'vitest'
import {
  classifyOffline,
  classifyFromMetadata,
  classifyFromProbe,
  shortsLimitSeconds,
  SHORTS_ERA_START,
  SHORTS_LIMIT_CHANGE,
  SHORTS_LIMIT_EARLY_SECONDS,
  SHORTS_LIMIT_LATE_SECONDS,
} from './youtube-shorts.js'

describe('shortsLimitSeconds', () => {
  it('is 60 seconds before the limit changed and 180 after', () => {
    expect(shortsLimitSeconds('2023-06-01T12:00:00')).toBe(SHORTS_LIMIT_EARLY_SECONDS)
    expect(shortsLimitSeconds('2025-06-01T12:00:00')).toBe(SHORTS_LIMIT_LATE_SECONDS)
  })

  it('changes ON 2024-10-15, not the day after', () => {
    expect(shortsLimitSeconds('2024-10-14T23:59:59')).toBe(SHORTS_LIMIT_EARLY_SECONDS)
    expect(shortsLimitSeconds(SHORTS_LIMIT_CHANGE)).toBe(SHORTS_LIMIT_LATE_SECONDS)
    expect(shortsLimitSeconds('2024-10-15T00:00:00')).toBe(SHORTS_LIMIT_LATE_SECONDS)
  })
})

describe('classifyOffline', () => {
  describe('no duration is terminal', () => {
    // These are the deleted and private videos — ~10.7k of them. Nothing can decide them,
    // and a run that retried them would burn its quota on 11% of the archive forever.
    it('is unclassifiable whatever the date', () => {
      for (const firstWatchedAtLocal of ['2011-01-01T00:00:00', '2020-09-02T00:00:00', '2026-08-16T12:12:00']) {
        expect(classifyOffline({ durationSeconds: null, firstWatchedAtLocal })).toEqual({
          isShort: null,
          method: 'unclassifiable',
          reason: 'no_duration',
        })
      }
    })

    it('takes precedence over the date rule, so a dead video is never reported as long-form', () => {
      const v = classifyOffline({ durationSeconds: null, firstWatchedAtLocal: '2015-01-01T00:00:00' })
      expect(v.method).toBe('unclassifiable')
      expect(v.isShort).toBeNull()
    })
  })

  describe('watched before Shorts existed', () => {
    it('rules out even a 5-second video', () => {
      expect(classifyOffline({ durationSeconds: 5, firstWatchedAtLocal: '2015-03-04T10:00:00' })).toEqual({
        isShort: false,
        method: 'duration_rule',
        reason: 'watched_before_shorts_existed',
      })
    })

    it('treats the era start itself as inside the Shorts era, not before it', () => {
      const before = classifyOffline({ durationSeconds: 30, firstWatchedAtLocal: '2020-08-31T23:59:00' })
      const onTheDay = classifyOffline({ durationSeconds: 30, firstWatchedAtLocal: `${SHORTS_ERA_START}T00:00:00` })
      expect(before.reason).toBe('watched_before_shorts_existed')
      expect(onTheDay.method).toBeNull()
    })
  })

  describe('the era limit', () => {
    // The whole reason a flat 180-second rule is wrong: this video is not a Short, but a
    // flat rule calls it one.
    it('rules out a 90-second video watched in 2023', () => {
      expect(classifyOffline({ durationSeconds: 90, firstWatchedAtLocal: '2023-04-01T12:00:00' })).toEqual({
        isShort: false,
        method: 'duration_rule',
        reason: 'longer_than_watch_era_limit',
      })
    })

    it('leaves the same 90-second video ambiguous when first watched after the limit rose', () => {
      expect(classifyOffline({ durationSeconds: 90, firstWatchedAtLocal: '2025-04-01T12:00:00' }).method).toBeNull()
    })

    it('lets a video sit exactly ON the limit — 60s and 180s are Shorts', () => {
      expect(classifyOffline({ durationSeconds: 60, firstWatchedAtLocal: '2023-04-01T12:00:00' }).method).toBeNull()
      expect(classifyOffline({ durationSeconds: 180, firstWatchedAtLocal: '2025-04-01T12:00:00' }).method).toBeNull()
    })

    it('rules out one second over', () => {
      expect(classifyOffline({ durationSeconds: 61, firstWatchedAtLocal: '2023-04-01T12:00:00' }).isShort).toBe(false)
      expect(classifyOffline({ durationSeconds: 181, firstWatchedAtLocal: '2025-04-01T12:00:00' }).isShort).toBe(false)
    })
  })

  describe('the earliest watch, not the latest', () => {
    // A watch date bounds the UPLOAD date from above and never from below, so only the
    // earliest watch is a sound bound. Passing a later rewatch would let a 2019 video
    // escape the date rule entirely.
    it('rules out a video whose first watch predates Shorts even though it was rewatched in 2025', () => {
      expect(classifyOffline({ durationSeconds: 20, firstWatchedAtLocal: '2019-02-02T09:00:00' }).reason)
        .toBe('watched_before_shorts_existed')
    })
  })

  describe('the ambiguous band', () => {
    it('has no verdict and no method, which is not the same as unclassifiable', () => {
      const v = classifyOffline({ durationSeconds: 30, firstWatchedAtLocal: '2025-01-01T12:00:00' })
      expect(v).toEqual({ isShort: null, method: null, reason: 'ambiguous' })
      expect(v.method).not.toBe('unclassifiable')
    })
  })

  describe('the two videos named in the brief', () => {
    it('settles fwLsCgibGw4 (553s, Palindrome Ages) offline as not a Short', () => {
      expect(classifyOffline({ durationSeconds: 553, firstWatchedAtLocal: '2026-06-16T19:31:00' })).toEqual({
        isShort: false,
        method: 'duration_rule',
        reason: 'longer_than_watch_era_limit',
      })
    })

    it('cannot settle oijqsP5wizI (7s, a genuine Short) offline', () => {
      expect(classifyOffline({ durationSeconds: 7, firstWatchedAtLocal: '2026-08-16T12:12:00' }).method).toBeNull()
    })
  })
})

describe('classifyFromMetadata', () => {
  it('rules out a video uploaded before Shorts existed, however recently it was watched', () => {
    expect(classifyFromMetadata({ durationSeconds: 45, publishedAt: '2013-05-14T10:00:00Z' })).toEqual({
      isShort: false,
      method: 'api_metadata',
      reason: 'uploaded_before_shorts_existed',
    })
  })

  it('applies the limit in force at UPLOAD, not at watch', () => {
    // 90 seconds, uploaded 2022 — over the 60s ceiling that applied then. Offline this row
    // would have stayed ambiguous if it was first watched after October 2024.
    expect(classifyFromMetadata({ durationSeconds: 90, publishedAt: '2022-03-01T00:00:00Z' })).toEqual({
      isShort: false,
      method: 'api_metadata',
      reason: 'longer_than_upload_era_limit',
    })
    expect(classifyFromMetadata({ durationSeconds: 90, publishedAt: '2025-03-01T00:00:00Z' }).method).toBeNull()
  })

  it('NEVER returns true — no metadata proves a Short, only the probe can', () => {
    const cases = [
      { durationSeconds: 7, publishedAt: '2026-01-01T00:00:00Z' },
      { durationSeconds: 60, publishedAt: '2021-01-01T00:00:00Z' },
      { durationSeconds: 180, publishedAt: '2025-01-01T00:00:00Z' },
      { durationSeconds: 1, publishedAt: '2024-12-31T00:00:00Z' },
    ]
    for (const c of cases) expect(classifyFromMetadata(c).isShort).not.toBe(true)
  })

  it('defers rather than deciding when the API gave nothing usable', () => {
    expect(classifyFromMetadata({ durationSeconds: 30, publishedAt: null }).method).toBeNull()
    expect(classifyFromMetadata({ durationSeconds: null, publishedAt: '2025-01-01T00:00:00Z' }).method).toBeNull()
  })
})

describe('classifyFromProbe', () => {
  it('confirms a Short when the request stays on /shorts/', () => {
    expect(classifyFromProbe(true)).toEqual({ isShort: true, method: 'probe', reason: 'stays_on_shorts_url' })
  })

  it('rules one out when the request redirects to /watch', () => {
    expect(classifyFromProbe(false)).toEqual({ isShort: false, method: 'probe', reason: 'redirects_to_watch_url' })
  })
})
