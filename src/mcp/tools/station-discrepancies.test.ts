import { describe, it, expect } from 'vitest'
import { compareStation, getStationDiscrepanciesSchema, type StoredStation } from './station-discrepancies.js'

// Bergen as the geocoder once stored it (Picardy, ADR 0065) and as viaduct places it.
const bergen: StoredStation = {
  name: 'Bergen',
  latitude: 49.98,
  longitude: 2.92,
  display_name: 'Bergen, Somme',
  country_code: 'fr',
  source: 'nominatim',
}

describe('compareStation', () => {
  it('measures the stored position against viaduct’s waypoint', () => {
    const c = compareStation(bergen, [{ latitude: 60.39, longitude: 5.33 }])!
    expect(c.distance_km).toBeGreaterThan(1000)
    expect(c.viaduct_latitude).toBe(60.39)
  })

  it('takes the nearest of two waypoints, so one that agrees clears the station', () => {
    const c = compareStation(
      { ...bergen, latitude: 45.4871, longitude: 9.2048, name: 'Milano Centrale' },
      [{ latitude: 50, longitude: 10 }, { latitude: 45.4859, longitude: 9.2043 }],
    )!
    expect(c.viaduct_latitude).toBe(45.4859)
    expect(c.distance_km).toBeLessThan(1)
  })

  it('has no distance for a station the geocoder never placed', () => {
    const c = compareStation({ ...bergen, latitude: null, longitude: null }, [{ latitude: 60.39, longitude: 5.33 }])!
    expect(c.distance_km).toBeNull()
  })

  it('is null when viaduct has no waypoint by that name', () => {
    expect(compareStation(bergen, [])).toBeNull()
  })
})

describe('getStationDiscrepanciesSchema', () => {
  it('defaults to 5 km, wrong towns rather than wrong platforms', () => {
    expect(getStationDiscrepanciesSchema.parse({}).min_km).toBe(5)
  })
})
