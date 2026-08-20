/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { TripImportResultPage } from './import.js'
import type { TripImportResult } from '../import.js'
import type { StoredTrip } from '../../lib/trip-prune.js'

// The result page is the only thing standing between reading a list and deleting the
// trips on it, so what is pinned here is when it offers that button — and, just as
// importantly, when it does not. A confirm form rendered beside a refusal would make
// the threshold advisory.

const trip = (id: string): StoredTrip => ({
  id,
  fromStation: 'Oslo S',
  toStation: 'Hamar',
  key: '2026-08-20 05:34:00',
  departureAt: new Date('2026-08-20T05:34:00Z'),
  departureLocal: new Date('2026-08-20T07:34:00Z'),
  arrivalAt: null,
  journey: 'Røros 2026',
  trainCode: null,
  status: 'Planned',
  distanceKm: 125,
  createdAt: new Date('2026-08-01T00:00:00Z'),
})

const result = (over: Partial<TripImportResult['prune']> = {}): TripImportResult => ({
  total: 4,
  inserted: 0,
  updated: 0,
  unchanged: 4,
  derivedAt: new Date('2026-08-20T12:00:00Z'),
  prune: {
    window: {
      from: new Date('2026-08-20T04:34:00Z'),
      to: new Date('2026-08-20T15:30:00Z'),
      fromKey: '2026-08-20 04:34:00',
      toKey: '2026-08-20 15:30:00',
    },
    inWindow: 5,
    candidates: [trip('a')],
    refusal: null,
    ...over,
  },
})

const render = (r: TripImportResult) => String(TripImportResultPage({ result: r }))

describe('TripImportResultPage', () => {
  it('lists what would go, and says plainly that nothing has gone', () => {
    const html = render(result())
    expect(html).toContain('Stored, but not in this export')
    expect(html).toContain('Nothing here has been deleted')
    expect(html).toContain('2026-08-20 05:34:00')
    expect(html).toContain('Røros 2026')
  })

  it('offers the confirm, carrying the range and the moment the plan was drawn', () => {
    const html = render(result())
    expect(html).toContain('action="/admin/import/trips/prune"')
    expect(html).toContain('name="trip" value="a"')
    expect(html).toContain('name="window_from" value="2026-08-20T04:34:00.000Z"')
    expect(html).toContain('name="window_to" value="2026-08-20T15:30:00.000Z"')
    expect(html).toContain('name="derived_at" value="2026-08-20T12:00:00.000Z"')
  })

  it('offers no confirm at all when the threshold refused', () => {
    // The refusal has to be the end of it. A button beside the explanation would make
    // the threshold a suggestion, which is exactly what it must not be.
    const html = render(result({ refusal: 'too many' }))
    expect(html).toContain('too many')
    expect(html).not.toContain('/admin/import/trips/prune')
  })

  it('offers no confirm when the export accounts for everything in its range', () => {
    const html = render(result({ candidates: [] }))
    expect(html).not.toContain('/admin/import/trips/prune')
    expect(html).not.toContain('Stored, but not in this export')
  })

  it('states the range, so the reader can see what was never eligible', () => {
    expect(render(result())).toContain('2026-08-20 15:30:00')
    expect(render(result())).toContain('5</strong> trips in that range')
  })
})
