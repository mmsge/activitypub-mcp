import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  buildTheatreConditions,
  getTheatreSchema,
  getTheatreDetailsSchema,
  getTheatreStatsSchema,
  shapeVisit,
  CREDIT_KEYS,
} from './theatre.js'

const dialect = new PgDialect()
const render = (f: Parameters<typeof buildTheatreConditions>[0]) =>
  dialect.sqlToQuery(sql.join(buildTheatreConditions(f), sql` AND `))

describe('buildTheatreConditions', () => {
  it('is live performance marks, wishlist out, hidden out, by default', () => {
    const { sql: q } = render({})
    expect(q).toContain("m.category = 'performance'")
    expect(q).toContain('m.deleted_at IS NULL')
    expect(q).toContain("m.status IS DISTINCT FROM 'wishlist'")
    expect(q).toContain('c.hidden_at IS NULL')
  })

  it('lets an explicit status, including wishlist, replace the wishlist exclusion', () => {
    const { sql: q, params } = render({ status: 'wishlist' })
    expect(q).toContain('m.status = $1')
    expect(q).not.toContain('IS DISTINCT FROM')
    expect(params).toContain('wishlist')
  })

  it('any_status drops the status condition entirely', () => {
    expect(render({ any_status: true }).sql).not.toContain('m.status')
  })

  it('windows on the night, never on when the mark was posted', () => {
    const { sql: q, params } = render({ year: 2026 })
    expect(q).toContain('m.watched_at >= $1::date')
    expect(q).toContain('m.watched_at < ($2::date + 1)')
    expect(q).not.toContain('published_at')
    expect(params).toEqual(['2026-01-01', '2026-12-31'])
  })

  it('an explicit edge overrides the year sugar on that edge only', () => {
    expect(render({ year: 2026, from: '2026-06-01' }).params).toEqual(['2026-06-01', '2026-12-31'])
  })

  it('searches the troupe out of details, and person across every credit key', () => {
    expect(render({ troupe: 'riks' }).sql).toContain("c.details->$1")
    const { params } = render({ person: 'Dåsnes' })
    for (const k of CREDIT_KEYS) expect(params).toContain(k)
    expect(params).toContain('%Dåsnes%')
    // cast holds objects, not names, and would match their JSON text.
    expect(params).not.toContain('cast')
  })

  it('qualifies every column by hand (the two tables share column names)', () => {
    const { sql: q } = render({ title: 'x', q: 'y', troupe: 'z', has_comment: true, item_type: 'Performance' })
    expect(q).not.toMatch(/"(title|comment|item_type|details)"/)
    expect(q).toContain('coalesce(c.display_title, c.title, m.title)')
  })
})

describe('schemas', () => {
  it('defaults to the night, newest first', () => {
    const p = getTheatreSchema.parse({})
    expect(p.sort_by).toBe('seen_at')
    expect(p.sort_order).toBe('desc')
    expect(p.limit).toBe(50)
    expect(p.has_comment).toBe(false)
  })

  it('rejects malformed input', () => {
    expect(() => getTheatreSchema.parse({ from: '2026' })).toThrow()
    expect(() => getTheatreSchema.parse({ status: 'seen' })).toThrow()
    expect(() => getTheatreSchema.parse({ item_type: 'Movie' })).toThrow()
    expect(() => getTheatreStatsSchema.parse({ top: 0 })).toThrow()
  })

  it('details takes an item_url or a title', () => {
    expect(getTheatreDetailsSchema.parse({ title: 'Ubesvart' }).title).toBe('Ubesvart')
  })
})

describe('shapeVisit', () => {
  const row = {
    mark_id: '00000000-0000-0000-0000-000000000001',
    item_url: 'https://minreol.dk/performance/1z2DQbq0PQZTICNDSTBI0q',
    item_type: 'Performance',
    title: 'Ubesvart anrop',
    orig_title: 'Ubesvart anrop (Riksteatret)',
    description: null,
    cover_url: null,
    year: null,
    language: ['no'],
    details: { troupe: ['Riksteatret'], orig_creator: ['Nora Dåsnes'], director: ['Toril Solvang-Kayiambakis'] },
    status: 'complete',
    watched_at: '2026-09-27T19:18:36.124Z',
    watched_date_unknown: false,
    comment: 'Sterkare enn eg forventa.',
    mark_url: 'https://minreol.dk/@markus/posts/627116884067411928/',
    actor_ap_id: 'https://minreol.dk/@markus@minreol.dk/',
    published_at: '2026-09-27T19:18:36.124Z',
    enriched_at: '2026-09-27T19:18:39.191Z',
    fetch_error: null,
    hidden_at: null,
  }

  it('lifts the credits out of details and keeps the night and the comment', () => {
    const v = shapeVisit(row)
    expect(v.seen_at).toBe('2026-09-27T19:18:36.124Z')
    expect(v.troupe).toEqual(['Riksteatret'])
    expect(v.orig_creator).toEqual(['Nora Dåsnes'])
    expect(v.venue).toEqual([])
    expect(v.cast).toEqual([])
    expect(v.comment).toBe('Sterkare enn eg forventa.')
    expect(v.marked_by).toBe('https://minreol.dk/@markus@minreol.dk/')
    expect(v.enriched).toBe(true)
    expect('fetch_error' in v).toBe(false)
  })

  it('a visit whose item is not enriched yet is still a visit', () => {
    const v = shapeVisit({ ...row, details: null, enriched_at: null, title: 'Hamlet' })
    expect(v.title).toBe('Hamlet')
    expect(v.troupe).toEqual([])
    expect(v.enriched).toBe(false)
  })

  it('reports a still-owed title', () => {
    expect(shapeVisit({ ...row, fetch_error: 'x' }).fetch_error).toBe('x')
  })
})
