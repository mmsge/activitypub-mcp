/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { StationsView } from './other-tabs.js'
import { BooksView, type TabCtx } from './media-tabs.js'
import { resolveTab } from '../categories.js'
import { statusLabel } from './kit.js'

const ctxFor = (cat: string, tab: string, over: Partial<TabCtx> = {}): TabCtx => {
  const r = resolveTab(cat, tab)!
  return { cat: r.cat, tab: r.tab, returnTo: `/admin/k/${cat}?tab=${tab}`, q: {}, running: new Set(), ...over }
}

const station = {
  name: 'Bergen',
  latitude: 49.98,
  longitude: 2.92,
  display_name: 'Bergen, Somme',
  country_code: 'fr',
  source: 'nominatim',
  viaduct_latitude: 60.390279,
  viaduct_longitude: 5.3333972,
  distance_km: 1234.5,
}

const report = (over = {}) => ({
  min_km: 5,
  coverage: { stations: 3, viaduct_waypoints: 749, agreeing: 1 },
  disagreeing: [station],
  not_geocoded: [],
  no_waypoint: ['Helsingborg'],
  ...over,
})

describe('StationsView', () => {
  it('pins to viaduct’s own coordinates, never the stored ones', () => {
    const html = String(StationsView({ ctx: ctxFor('reiser', 'stasjonar'), report: report() as never }))
    expect(html).toContain('action="/admin/stations/pin"')
    expect(html).toContain('name="latitude" value="60.390279"')
    expect(html).toContain('name="longitude" value="5.3333972"')
    expect(html).toContain('1234.5 km')
    expect(html).toContain('>Fest</button>')
  })

  it('says why the page is empty when no GPX has been imported', () => {
    const html = String(StationsView({
      ctx: ctxFor('reiser', 'stasjonar'),
      report: report({ disagreeing: [], coverage: { stations: 3, viaduct_waypoints: 0, agreeing: 0 } }) as never,
    }))
    expect(html).toContain('Importer GPX-fila')
    expect(html).not.toContain('/admin/stations/pin')
  })
})

const book = {
  id: 'b1', bookUrl: 'https://bookwyrm.social/book/1', title: 'Piranesi', author: 'Susanna Clarke', series: null,
  pages: 272, physicalFormat: null, language: null, pubYear: null, coverUrl: null, fetchedAt: new Date(),
  hiddenAt: null as Date | null, shelf: 'read' as const, started: null, finished: new Date('2026-09-14T12:00:00Z'), rating: '4',
  lastActivity: null,
}

describe('BooksView', () => {
  const page = (rows: typeof book[], over = {}) => ({ rows, total: rows.length, page: 0, hasMore: false, ...over })

  it('renders a row with its ⋯ menu pointing at the same POST endpoints', () => {
    const html = String(BooksView({ ctx: ctxFor('lesing', 'boker'), data: page([book]), actors: ['@m@b'] }))
    expect(html).toContain('Piranesi')
    expect(html).toContain('Susanna Clarke · 272 s. · lese 14. sep. 2026 · ★ 4')
    expect(html).toContain('action="/admin/media/reenrich"')
    expect(html).toMatch(/data-menu="[^"]*&quot;k&quot;:&quot;book&quot;/)
  })

  it('shows a hidden row dimmed and badged', () => {
    const html = String(BooksView({ ctx: ctxFor('lesing', 'boker'), data: page([{ ...book, hiddenAt: new Date() }]), actors: [] }))
    expect(html).toContain('class="r r-hidden"')
    expect(html).toContain('>Skjult</span>')
  })

  it('says what an empty tab means', () => {
    const html = String(BooksView({ ctx: ctxFor('lesing', 'boker'), data: page([]), actors: ['@m@b'] }))
    expect(html).toContain('Ingen bøker. Dei kjem når BookWyrm-kontoen blir følgd.')
  })

  it('pages with "Vis fleire" and keeps the search', () => {
    const html = String(BooksView({
      ctx: ctxFor('lesing', 'boker', { q: { title: 'pir' } }), data: page([book], { total: 60, hasMore: true }), actors: [],
    }))
    expect(html).toContain('href="/admin/k/lesing?title=pir&amp;tab=boker&amp;page=1"')
    expect(html).toContain('Vis fleire · 59 til')
  })

  it('lists the category’s imports and syncs, and disables a running sync', () => {
    const html = String(BooksView({ ctx: ctxFor('lesing', 'boker', { running: new Set(['books']) }), data: page([]), actors: [] }))
    expect(html).toContain('href="/admin/import/storygraph"')
    expect(html).toMatch(/<button type="submit" class="btn-run" disabled="">Køyrer<\/button>/)
    expect(html).toMatch(/value="reading"\/><input type="hidden" name="return"[^>]*\/><button type="submit" class="btn-run">Køyr<\/button>/)
  })
})

describe('statusLabel', () => {
  it('translates origin status values for display', () => {
    expect(statusLabel('complete')).toBe('Fullført')
    expect(statusLabel('wishlist', 'music')).toBe('Vil høyre')
    expect(statusLabel('wishlist', 'movie')).toBe('Vil sjå')
    expect(statusLabel('went')).toBe('Var der')
    expect(statusLabel(null)).toBeNull()
  })
})
