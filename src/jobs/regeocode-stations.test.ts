import { describe, it, expect } from 'vitest'
import { distanceKm, SAME_PLACE_KM } from './regeocode-stations.js'

describe('distanceKm', () => {
  it('measures the old Bergen hit in Picardy as a different place entirely', () => {
    // 49.98421, 2.9206 is where the timezone-as-country filter put Bergen.
    const km = distanceKm(49.98421, 2.9206, 60.3903, 5.3331)
    expect(km).toBeGreaterThan(1100)
    expect(km).toBeLessThan(1200)
  })

  it('reads a platform-sized correction as the same place', () => {
    expect(distanceKm(60.3903, 5.3331, 60.3943, 5.3259)).toBeLessThan(SAME_PLACE_KM)
  })

  it('is zero for the same point', () => {
    expect(distanceKm(59.911, 10.753, 59.911, 10.753)).toBe(0)
  })
})
