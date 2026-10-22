import { describe, it, expect } from 'vitest'
import { buildTrainTripsQuery, getTrainTripsSchema, shapeTripRow } from './train-trips.js'
import { encodeCursor } from './pagination.js'

type Row = Parameters<typeof shapeTripRow>[0]

const baseRow: Row = {
  id: '11111111-2222-3333-4444-555555555555',
  departureAt: new Date('2026-11-02T07:58:00Z'),
  arrivalAt: new Date('2026-11-02T14:41:00Z'),
  from: 'Bergen',
  to: 'Oslo S',
  journey: 'Haust',
  trainCode: 'R 602',
  operator: 'Vy',
  mode: 'Train',
  travelClass: 'Standard',
  distanceKm: 471,
  delay: null,
  night: false,
  status: 'Planned',
  tags: ['bergensbanen'],
  fromTz: 'Europe/Oslo',
  toTz: 'Europe/Oslo',
  fromLat: '60.3903',
  fromLon: '5.3329',
  toLat: '59.9111',
  toLon: '10.7528',
}

describe('shapeTripRow', () => {
  it('carries the station zones and turns numeric coordinates into numbers', () => {
    const out = shapeTripRow(baseRow)
    expect(out.fromTz).toBe('Europe/Oslo')
    expect(out.toTz).toBe('Europe/Oslo')
    expect(out.fromLat).toBe(60.3903)
    expect(out.fromLon).toBe(5.3329)
    expect(out.toLat).toBe(59.9111)
    expect(out.toLon).toBe(10.7528)
  })

  it('is null, not 0 or NaN, where the station is not geocoded or the zone unknown', () => {
    const out = shapeTripRow({
      ...baseRow,
      fromTz: null,
      toTz: null,
      fromLat: null,
      fromLon: null,
      toLat: null,
      toLon: null,
    })
    expect(out.fromTz).toBeNull()
    expect(out.toTz).toBeNull()
    expect(out.fromLat).toBeNull()
    expect(out.fromLon).toBeNull()
    expect(out.toLat).toBeNull()
    expect(out.toLon).toBeNull()
  })

  it('keeps the existing fields in their order, drops the id, and only appends', () => {
    const out = shapeTripRow(baseRow)
    expect(Object.keys(out)).toEqual([
      'departureAt', 'arrivalAt', 'from', 'to', 'journey', 'trainCode', 'operator', 'mode',
      'travelClass', 'distanceKm', 'delay', 'night', 'status', 'tags',
      'fromTz', 'toTz', 'fromLat', 'fromLon', 'toLat', 'toLon',
    ])
    expect(out).not.toHaveProperty('id')
  })
})

describe('buildTrainTripsQuery', () => {
  const render = (input: Record<string, unknown> = {}) =>
    buildTrainTripsQuery(getTrainTripsSchema.parse(input)).toSQL().sql

  it('LEFT joins stations twice, by exact name, so ungeocoded trips still appear', () => {
    const q = render()
    expect(q).toContain('left join "stations" "from_station_geo" on "from_station_geo"."name" = "train_trips"."from_station"')
    expect(q).toContain('left join "stations" "to_station_geo" on "to_station_geo"."name" = "train_trips"."to_station"')
    expect(q).not.toMatch(/\binner join\b/)
  })

  it('prefers each station\'s own zone over the leg\'s, and reads the coordinates off each end', () => {
    // Viaduct writes Europe/Paris for every CET station; the station's zone comes
    // from the country it geocoded to (ADR 0065). The leg's zone is the fallback.
    const q = render()
    expect(q).toContain('coalesce("from_station_geo"."timezone", "train_trips"."from_tz")')
    expect(q).toContain('coalesce("to_station_geo"."timezone", "train_trips"."to_tz")')
    expect(q).toContain('"from_station_geo"."latitude"')
    expect(q).toContain('"from_station_geo"."longitude"')
    expect(q).toContain('"to_station_geo"."latitude"')
    expect(q).toContain('"to_station_geo"."longitude"')
  })

  it('keeps filters and the cursor on the trip columns, not the joined name', () => {
    const cursor = encodeCursor(new Date('2026-11-01T00:00:00Z'), '11111111-2222-3333-4444-555555555555')
    const q = render({ station: 'Bergen', cursor })
    expect(q).toContain('"train_trips"."from_station" ilike')
    expect(q).toContain('"train_trips"."departure_at"')
    expect(q).not.toMatch(/"name" ilike/)
  })
})
