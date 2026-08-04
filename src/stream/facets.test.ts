import { describe, it, expect } from 'vitest'
import {
  parsePlatform, parseKind, parseTag, parseArchive, parseCursor,
  archiveRange, cacheKey, UnknownFacetError, EMPTY_FACETS, PAGE_SIZE,
} from './facets.js'
import { encodeCursor, InvalidCursorError } from '../mcp/tools/pagination.js'

describe('parsePlatform', () => {
  it('accepts every configured source', () => {
    for (const p of ['mastodon', 'bookwyrm', 'pixelfed', 'loops', 'neodb', 'lastfm', 'tog', 'hage']) {
      expect(parsePlatform(p)).toBe(p)
    }
  })

  it('is case- and whitespace-insensitive', () => {
    expect(parsePlatform(' Mastodon ')).toBe('mastodon')
  })

  it('rejects anything else rather than falling back to unfiltered', () => {
    // Silently ignoring an unknown filter would serve the whole stream under a
    // filtered URL — and mint a cache entry per typo.
    for (const bad of ['twitter', '', '   ', undefined, null, 'mastodon;drop', '../']) {
      expect(() => parsePlatform(bad)).toThrow(UnknownFacetError)
    }
  })
})

describe('parseKind', () => {
  it('accepts a known kind', () => {
    expect(parseKind('book_review')).toBe('book_review')
    expect(parseKind('scrobble_day')).toBe('scrobble_day')
  })

  it('rejects an unknown kind', () => {
    for (const bad of ['bok', 'anything', '', undefined]) {
      expect(() => parseKind(bad)).toThrow(UnknownFacetError)
    }
  })
})

describe('parseTag', () => {
  it('strips the hash and lowercases', () => {
    expect(parseTag('#TogSelfie')).toBe('togselfie')
    expect(parseTag('togselfie')).toBe('togselfie')
  })

  it('keeps Norwegian letters and digits', () => {
    expect(parseTag('#bøker2026')).toBe('bøker2026')
    expect(parseTag('#lese_liste')).toBe('lese_liste')
  })

  it('rejects anything that is not a plain tag', () => {
    // This value reaches a LIKE pattern and a cache key.
    for (const bad of ['', '#', '   ', '%', 'a%b', "a'b", 'a b', 'a-b', 'a/b', '#'.repeat(200), 'x'.repeat(101)]) {
      expect(() => parseTag(bad)).toThrow(UnknownFacetError)
    }
  })
})

describe('parseArchive', () => {
  it('accepts a real year and month', () => {
    expect(parseArchive('2026', '08')).toEqual({ year: 2026, month: 8 })
    expect(parseArchive('2026', '8')).toEqual({ year: 2026, month: 8 })
  })

  it('rejects a month outside 1–12', () => {
    for (const m of ['0', '13', '99', '-1', 'ja', '']) {
      expect(() => parseArchive('2026', m)).toThrow(UnknownFacetError)
    }
  })

  it('rejects an implausible or malformed year', () => {
    for (const y of ['26', '20266', '1899', '2101', 'abcd', '']) {
      expect(() => parseArchive(y, '01')).toThrow(UnknownFacetError)
    }
  })
})

describe('archiveRange', () => {
  it('is half-open and bounded on Oslo midnight, not UTC midnight', () => {
    // August is CEST (UTC+2), so the month starts two hours before midnight UTC.
    const { start, end } = archiveRange(2026, 8)
    expect(start.toISOString()).toBe('2026-07-31T22:00:00.000Z')
    expect(end.toISOString()).toBe('2026-08-31T22:00:00.000Z')
  })

  it('uses the winter offset in winter', () => {
    const { start, end } = archiveRange(2026, 1)
    expect(start.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(end.toISOString()).toBe('2026-01-31T23:00:00.000Z')
  })

  it('follows the offset across the March and October transitions', () => {
    // The switch happens mid-month, so March opens on CET and closes on CEST.
    expect(archiveRange(2026, 3).start.toISOString()).toBe('2026-02-28T23:00:00.000Z')
    expect(archiveRange(2026, 3).end.toISOString()).toBe('2026-03-31T22:00:00.000Z')
    expect(archiveRange(2026, 10).start.toISOString()).toBe('2026-09-30T22:00:00.000Z')
    expect(archiveRange(2026, 10).end.toISOString()).toBe('2026-10-31T23:00:00.000Z')
  })

  it('rolls December into the next year', () => {
    const { start, end } = archiveRange(2026, 12)
    expect(start.toISOString()).toBe('2026-11-30T23:00:00.000Z')
    expect(end.toISOString()).toBe('2026-12-31T23:00:00.000Z')
  })

  it('adjacent months meet exactly, leaving no gap and no overlap', () => {
    for (let m = 1; m <= 11; m++) {
      expect(archiveRange(2026, m).end.getTime()).toBe(archiveRange(2026, m + 1).start.getTime())
    }
    expect(archiveRange(2026, 12).end.getTime()).toBe(archiveRange(2027, 1).start.getTime())
  })

  it('files an entry in the month its own printed date says', () => {
    // The page renders every date in Oslo. Under UTC bounds this post read
    // "1. juli" and was served from /arkiv/2026/06.
    const lateJune = new Date('2026-06-30T23:30:00Z') // 01:30 on 1 July in Oslo
    const july = archiveRange(2026, 7)
    expect(lateJune >= july.start && lateJune < july.end).toBe(true)
    const june = archiveRange(2026, 6)
    expect(lateJune >= june.start && lateJune < june.end).toBe(false)
  })

  it('keeps a scrobble digest in the month of its own day', () => {
    // The music lane's event_at *is* Oslo midnight, so under UTC bounds the digest
    // for the 1st fell in the previous month — every month, all year.
    for (const [year, month] of [[2026, 3], [2026, 8], [2026, 11]] as const) {
      const osloMidnightOnTheFirst = archiveRange(year, month).start
      const { start, end } = archiveRange(year, month)
      expect(osloMidnightOnTheFirst >= start && osloMidnightOnTheFirst < end).toBe(true)
    }
  })

  it('keeps day-precision garden dates in their own month', () => {
    // Garden frontmatter parses to UTC midnight. Oslo is east of UTC, so its month
    // opens before the UTC month does and the whole calendar month fits inside.
    for (const [month, days] of [[3, 31], [7, 31], [10, 31], [2, 28]] as const) {
      const { start, end } = archiveRange(2026, month)
      for (const day of [1, 2, days - 1, days]) {
        const at = new Date(Date.UTC(2026, month - 1, day))
        expect([month, day, at >= start && at < end]).toEqual([month, day, true])
      }
    }
  })
})

describe('parseCursor', () => {
  it('passes a well-formed token through verbatim', () => {
    const token = encodeCursor(new Date('2026-08-01T00:00:00Z'), 'post:abc')
    expect(parseCursor(token)).toBe(token)
  })

  it('treats absent as unfiltered', () => {
    expect(parseCursor(undefined)).toBeNull()
    expect(parseCursor('')).toBeNull()
  })

  it('rejects garbage at the edge, so it is a 400 rather than a 500', () => {
    expect(() => parseCursor('not-a-cursor')).toThrow(InvalidCursorError)
    expect(() => parseCursor('x'.repeat(600))).toThrow(InvalidCursorError)
  })
})

describe('cacheKey', () => {
  it('is stable for the same facets', () => {
    expect(cacheKey(EMPTY_FACETS)).toBe(cacheKey({ ...EMPTY_FACETS }))
  })

  it('separates pages that differ in any dimension', () => {
    const keys = new Set([
      cacheKey(EMPTY_FACETS),
      cacheKey({ ...EMPTY_FACETS, platform: 'mastodon' }),
      cacheKey({ ...EMPTY_FACETS, kind: 'book_review' }),
      cacheKey({ ...EMPTY_FACETS, tag: 'togselfie' }),
      cacheKey({ ...EMPTY_FACETS, year: 2026, month: 8 }),
      cacheKey({ ...EMPTY_FACETS, cursor: 'abc' }),
      cacheKey({ ...EMPTY_FACETS, limit: 50 }),
    ])
    expect(keys.size).toBe(7)
  })

  it('is built from a fixed field order, not from request order', () => {
    // Two requests that differ only in query-string order are one page, and must
    // therefore be one cache entry.
    const a = cacheKey({ ...EMPTY_FACETS, platform: 'mastodon', tag: 'bok' })
    const b = cacheKey({ ...EMPTY_FACETS, tag: 'bok', platform: 'mastodon' })
    expect(a).toBe(b)
  })

  it('distinguishes a month from a tag that looks like one', () => {
    expect(cacheKey({ ...EMPTY_FACETS, year: 2026, month: 8 }))
      .not.toBe(cacheKey({ ...EMPTY_FACETS, tag: '202608' }))
  })

  it('defaults to the fixed page size — limit is never client-settable', () => {
    expect(EMPTY_FACETS.limit).toBe(PAGE_SIZE)
  })
})
