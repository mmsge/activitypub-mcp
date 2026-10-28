import { describe, it, expect } from 'vitest'
import { distanceKm, trackLengthKm } from './geo-distance.js'

describe('trackLengthKm', () => {
  it('sums each segment and never bridges the gap between two', () => {
    const a: [number, number][] = [[10.75, 59.91], [10.75, 60.0]]
    const b: [number, number][] = [[5.33, 60.39], [5.33, 60.48]]
    const one = distanceKm(59.91, 10.75, 60.0, 10.75)
    const two = distanceKm(60.39, 5.33, 60.48, 5.33)
    expect(trackLengthKm([a, b])).toBe(Math.round((one + two) * 10) / 10)
    // Bridging Oslo to Bergen would add some 300 km that nobody drew.
    expect(trackLengthKm([a, b])).toBeLessThan(25)
  })

  it('rounds once, to one decimal', () => {
    expect(trackLengthKm([[[0, 0], [0, 1]]])).toBe(111.2)
  })

  it('is zero for nothing drawn', () => {
    expect(trackLengthKm([])).toBe(0)
  })
})
