/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { routeSvgPath, everyText, JobsView, TripsView, ReadingEventsView } from './data-tabs.js'
import type { TabCtx } from './media-tabs.js'
import { resolveTab } from '../categories.js'
import { JOBS } from '../../jobs/job-runs.js'

const ctxFor = (cat: string, tab: string): TabCtx => {
  const r = resolveTab(cat, tab)!
  return { cat: r.cat, tab: r.tab, returnTo: `/admin/k/${cat}?tab=${tab}`, q: {}, running: new Set() }
}
const now = new Date('2026-11-01T12:00:00Z')

describe('routeSvgPath', () => {
  it('draws each segment on its own and never bridges the gap between them', () => {
    const paths = routeSvgPath([[[5.3, 60.4], [6.0, 60.6]], [[8.0, 60.0], [10.75, 59.91]]])
    expect(paths).toHaveLength(2)
    expect(paths.every((p) => p.startsWith('M'))).toBe(true)
  })

  it('keeps the shape inside the thumbnail, north up', () => {
    const [d] = routeSvgPath([[[10, 60], [10, 61]]])
    const nums = d!.match(/-?\d+(\.\d+)?/g)!.map(Number)
    for (const n of nums) { expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(56) }
    // The northern point is drawn above (smaller y) the southern one.
    expect(nums[3]!).toBeLessThan(nums[1]!)
  })

  it('thins a long track and keeps its last point', () => {
    const seg = Array.from({ length: 1000 }, (_, i) => [10 + i / 1000, 60])
    const [d] = routeSvgPath([seg], 56, 4, 60)
    expect(d!.split('L').length).toBeLessThanOrEqual(61)
    expect(d!.endsWith('L52.0 28.0')).toBe(true)
  })

  it('draws nothing for a single point', () => {
    expect(routeSvgPath([[[10, 60]]])).toEqual([])
  })
})

describe('everyText', () => {
  it('says how often in plain nynorsk', () => {
    expect(everyText(30_000)).toBe('kvart 30. sekund')
    expect(everyText(60_000)).toBe('kvart minutt')
    expect(everyText(3_600_000)).toBe('kvar time')
    expect(everyText(6 * 3_600_000)).toBe('kvar 6. time')
    expect(everyText(168 * 3_600_000)).toBe('kvar 7. dag')
  })
})

describe('JobsView', () => {
  const job = (id: string) => JOBS.find((j) => j.id === id)!

  it('tells off, never run, OK and failed apart', () => {
    const html = String(JobsView({
      ctx: ctxFor('system', 'jobbar'), now,
      jobs: [
        { job: job('linkedin'), intervalMs: null, last: null, lastFailure: null },
        { job: job('neodb'), intervalMs: 6 * 3_600_000, last: null, lastFailure: null },
        { job: job('delivery'), intervalMs: 30_000, last: { ranAt: new Date('2026-11-01T11:59:40Z'), ok: true, summary: '12 ms', error: null }, lastFailure: null },
        { job: job('stations'), intervalMs: 6 * 3_600_000, last: { ranAt: new Date('2026-11-01T09:00:00Z'), ok: false, summary: null, error: 'Nominatim 429' }, lastFailure: null },
      ],
    }))
    expect(html).toContain('slå på med LINKEDIN_DMA_TOKEN')
    expect(html).toContain('>Ikkje køyrd enno</span>')
    expect(html).toContain('kvart 30. sekund · sist 20 s sidan · 12 ms')
    expect(html).toContain('>Feila</span>')
    expect(html).toContain('Nominatim 429')
  })
})

describe('the scheduler', () => {
  it('records every job under an id the Jobbar tab knows', () => {
    const src = readFileSync(fileURLToPath(new URL('../../jobs/scheduler.ts', import.meta.url)), 'utf8')
    const ids = [...src.matchAll(/runJob\('([a-z-]+)'/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(15)
    for (const id of ids) expect(JOBS.some((j) => j.id === id)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('TripsView', () => {
  const trip = (over = {}) => ({
    departureAt: new Date('2026-10-30T06:34:00Z'), arrivalAt: null, from: 'Oslo S', to: 'Bergen', journey: 'Haust',
    trainCode: 'R 61', operator: 'Vy', mode: 'Train', travelClass: null, distanceKm: '496', delay: null, night: false,
    status: 'Planned', tags: [], fromTz: 'Europe/Oslo', toTz: 'Europe/Oslo',
    fromLat: null, fromLon: null, toLat: null, toLon: null, measuredKm: null, ...over,
  })
  const result = (trips: unknown[]) => ({ count: trips.length, page: 1, next_cursor: null, sort_order: 'desc', filters: {}, trips }) as never

  it('counts a departed leg as gone even when viaduct still says Planned', () => {
    const html = String(TripsView({ ctx: ctxFor('reiser', 'turar'), result: result([trip()]), page: 1, now }))
    expect(html).toContain('Oslo S → Bergen')
    expect(html).toContain('>Gått</span>')
    expect(html).toContain('07:34')
  })

  it('keeps a future leg planned', () => {
    const html = String(TripsView({ ctx: ctxFor('reiser', 'turar'), result: result([trip({ departureAt: new Date('2026-12-01T06:34:00Z') })]), page: 1, now }))
    expect(html).toContain('>Planlagd</span>')
  })
})

describe('ReadingEventsView', () => {
  it('says so when no BookWyrm account is configured', () => {
    const html = String(ReadingEventsView({ ctx: ctxFor('lesing', 'lesingar'), actors: [], result: { error: 'BOOKWYRM_ACTORS er ikkje sett' } }))
    expect(html).toContain('BOOKWYRM_ACTORS er ikkje sett')
  })
})
