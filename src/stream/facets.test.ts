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
  it('is half-open, so a month never overlaps the next', () => {
    const { start, end } = archiveRange(2026, 8)
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('rolls December into the next year', () => {
    const { start, end } = archiveRange(2026, 12)
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('adjacent months meet exactly, leaving no gap and no overlap', () => {
    expect(archiveRange(2026, 7).end.getTime()).toBe(archiveRange(2026, 8).start.getTime())
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
