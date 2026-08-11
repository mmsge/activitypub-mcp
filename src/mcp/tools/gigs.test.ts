import { describe, it, expect } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { gigCatalog } from '../../db/schema.js'
import {
  getGigsSchema,
  getGigDetailsSchema,
  getGigStatsSchema,
  loggedAtExpr,
  photosExpr,
  reviewsExpr,
  rsvpSourceExpr,
  rsvpStatusExpr,
} from './gigs.js'
import { encodeCursor, decodeCursor } from './pagination.js'

describe('getGigsSchema', () => {
  it('defaults to the night of the gig, newest first', () => {
    const parsed = getGigsSchema.parse({})
    // The default that matters most: an archive imported in one afternoon must read as
    // a history, not as the order the import happened to run in.
    expect(parsed.sort_by).toBe('gig_date')
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    expect(parsed.include_hidden).toBe(false)
    expect(parsed.include_unenriched).toBe(false)
    expect(parsed.has_review).toBe(false)
    expect(parsed.has_setlist).toBe(false)
  })

  it('accepts every filter', () => {
    const parsed = getGigsSchema.parse({
      artist: 'Motorpsycho', venue: 'Rockefeller', city: 'Oslo', country: 'no',
      festival: 'Øya', tour: 'Ei ferd', song: 'Vortex', q: 'best',
      status: 'attended', concert_status: 'completed',
      year: 2023, from: '2023-01-01', to: '2023-12-31',
      has_review: true, has_setlist: true, limit: 200, page: 3,
    })
    expect(parsed.artist).toBe('Motorpsycho')
    expect(parsed.status).toBe('attended')
    expect(parsed.year).toBe(2023)
    expect(parsed.limit).toBe(200)
  })

  it('rejects out-of-range and malformed input', () => {
    expect(() => getGigsSchema.parse({ limit: 0 })).toThrow()
    expect(() => getGigsSchema.parse({ limit: 201 })).toThrow()
    expect(() => getGigsSchema.parse({ page: 0 })).toThrow()
    expect(() => getGigsSchema.parse({ sort_by: 'published_at' })).toThrow()
    expect(() => getGigsSchema.parse({ sort_order: 'sideways' })).toThrow()
    // The RSVP states are a closed set, and 'went' is not one of them.
    expect(() => getGigsSchema.parse({ status: 'went' })).toThrow()
    expect(() => getGigsSchema.parse({ concert_status: 'finished' })).toThrow()
    // A date has to be a date, or the window silently matches nothing.
    expect(() => getGigsSchema.parse({ from: '2023' })).toThrow()
    expect(() => getGigsSchema.parse({ to: '01-01-2023' })).toThrow()
  })

  it('round-trips a cursor', () => {
    const at = new Date('2026-01-10T00:00:00.000Z')
    const token = encodeCursor(at, '11111111-2222-3333-4444-555555555555')
    expect(getGigsSchema.parse({ cursor: token }).cursor).toBe(token)
    const decoded = decodeCursor(token)
    expect(decoded.p).toBe(at.toISOString())
    expect(decoded.id).toBe('11111111-2222-3333-4444-555555555555')
  })
})

describe('getGigDetailsSchema / getGigStatsSchema', () => {
  it('takes either a URL or a title', () => {
    expect(getGigDetailsSchema.parse({ concert_url: 'https://samklang.msge.no/konsert/K' }).concert_url)
      .toBe('https://samklang.msge.no/konsert/K')
    expect(getGigDetailsSchema.parse({ title: 'Motorpsycho' }).title).toBe('Motorpsycho')
    expect(getGigDetailsSchema.parse({}).include_hidden).toBe(false)
  })

  it('bounds the top-N breakdowns', () => {
    expect(getGigStatsSchema.parse({}).top).toBe(10)
    expect(() => getGigStatsSchema.parse({ top: 0 })).toThrow()
    expect(() => getGigStatsSchema.parse({ top: 51 })).toThrow()
    expect(() => getGigStatsSchema.parse({ status: 'went' })).toThrow()
  })
})

describe('the correlated subqueries', () => {
  // Drizzle qualifies a bare column reference inside WHERE but NOT inside a select-list
  // expression, where `concert_url` binds to the subquery's own table — an always-true
  // self-comparison that hands every row every other row's data. It produces no error and
  // a perfectly plausible response shape, which is why it needs a test rather than
  // review. The same bug shipped once in get_watched's mark_comments (ADR 0011), and it
  // shipped again here in get_gig_stats before this test existed.
  const rendered = (expr: SQL<unknown>): string =>
    getDb().select({ value: expr }).from(gigCatalog).toSQL().sql

  for (const [name, expr] of [
    ['rsvp_status', rsvpStatusExpr],
    ['status_source', rsvpSourceExpr],
    ['reviews', reviewsExpr],
    ['photos', photosExpr],
    ['logged_at', loggedAtExpr],
  ] as const) {
    it(`correlates ${name} against gig_catalog, table-qualified`, () => {
      const sql = rendered(expr)
      expect(sql).toContain('a.concert_url = gig_catalog.concert_url')
      // The failure mode: an unqualified right-hand side.
      expect(sql).not.toMatch(/a\.concert_url = "?concert_url"?[^.]/)
    })
  }

  it('excludes tombstoned attendances from every one of them', () => {
    for (const expr of [rsvpStatusExpr, rsvpSourceExpr, reviewsExpr, photosExpr, loggedAtExpr]) {
      expect(rendered(expr)).toContain('deleted_at IS NULL')
    }
  })
})
