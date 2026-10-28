import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { closestApproachSql, getTripTracksSchema } from './trip-tracks.js'

describe('near filter', () => {
  it('takes near_lat and near_lon together or not at all', () => {
    expect(getTripTracksSchema.safeParse({ near_lat: 53.55 }).success).toBe(false)
    expect(getTripTracksSchema.safeParse({ near_lon: 10.0 }).success).toBe(false)
    expect(getTripTracksSchema.safeParse({ near_lat: 53.55, near_lon: 10.0 }).success).toBe(true)
    expect(getTripTracksSchema.safeParse({}).success).toBe(true)
  })

  it('defaults to 5 km', () => {
    expect(getTripTracksSchema.parse({ near_lat: 53.55, near_lon: 10.0 }).near_km).toBe(5)
  })

  it('narrows to a bounding box before it runs the haversine', () => {
    const q = new PgDialect().sqlToQuery(closestApproachSql(53.55, 10.0, 5))
    expect(q.sql).toContain('BETWEEN')
    expect(q.sql).toContain('asin(least(1, sqrt(')
    // 5 km is about 0.045 degrees of latitude either side.
    const [latLo, latHi] = q.params.slice(-4, -2) as number[]
    expect(latHi - latLo).toBeCloseTo(0.09, 2)
    // And a wider band of longitude, since a degree of it is shorter up here.
    const [lonLo, lonHi] = q.params.slice(-2) as number[]
    expect(lonHi - lonLo).toBeGreaterThan(latHi - latLo)
  })
})
