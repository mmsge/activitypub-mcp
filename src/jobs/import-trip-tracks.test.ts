import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { importTripTracks, tripTrackMatchSql } from './import-trip-tracks.js'

describe('tripTrackMatchSql', () => {
  it('joins on the trip identity as the GPX spells it: stations and the local wall clock', () => {
    const q = new PgDialect().sqlToQuery(tripTrackMatchSql('tt', 't')).sql
    expect(q).toBe(
      '"tt".from_station = "t".from_station AND "tt".to_station = "t".to_station AND "tt".departure_local = "t".departure_local',
    )
    // Never the instant: the GPX has no zone, and viaduct's zones are per offset rule.
    expect(q).not.toContain('departure_at')
  })
})

describe('importTripTracks', () => {
  it('refuses a file with no tracks instead of emptying the table', async () => {
    // Rejected before any query, so no database is needed to prove it.
    await expect(importTripTracks({ tracks: [], waypoints: [], problems: [] })).rejects.toThrow(/no readable tracks/)
  })
})
