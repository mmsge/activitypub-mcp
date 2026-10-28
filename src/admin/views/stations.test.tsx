/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { StationsPage } from './stations.js'

const row = {
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
  disagreeing: [row],
  not_geocoded: [],
  no_waypoint: ['Helsingborg'],
  ...over,
})

describe('StationsPage', () => {
  it('pins to viaduct’s own coordinates, never the stored ones', () => {
    const html = String(StationsPage({ report: report() }))
    expect(html).toContain('action="/admin/stations/pin"')
    expect(html).toContain('name="latitude" value="60.390279"')
    expect(html).toContain('name="longitude" value="5.3333972"')
    expect(html).toContain('1234.5')
  })

  it('says why the page is empty when no GPX has been imported', () => {
    const html = String(
      StationsPage({ report: report({ disagreeing: [], coverage: { stations: 3, viaduct_waypoints: 0, agreeing: 0 } }) }),
    )
    expect(html).toContain('Import the GPX')
    expect(html).not.toContain('/admin/stations/pin')
  })
})
