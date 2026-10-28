/** Haversine distance in km. Pure. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The drawn length of a route, in km to one decimal: the sum of every segment's own
 * length, never the gaps between segments. viaduct does not put segments in travel order,
 * so a gap is not a known distance, and bridging it would be a guess. See ADR 0071.
 *
 * Mirrored in SQL by `drizzle/0046_trip_track_measured_km.sql`, which backfilled the rows
 * stored before this existed; the two use the same radius and the same rounding.
 */
export function trackLengthKm(segments: readonly (readonly (readonly [number, number])[])[]): number {
  let km = 0
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const [lon0, lat0] = seg[i - 1]
      const [lon1, lat1] = seg[i]
      km += distanceKm(lat0, lon0, lat1, lon1)
    }
  }
  return Math.round(km * 10) / 10
}
