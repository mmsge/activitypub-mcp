/**
 * Great-circle distance, and what it says about a geocode.
 *
 * A station name resolved by an open geocoder is right most of the time and
 * confidently wrong the rest — "Falkenberg" matches a town in Moselle, "Arna"
 * a ridge above Nice. Neither failure announces itself: the lookup succeeds,
 * coordinates get stored, and the weather comes from the wrong country.
 *
 * The archive can check the work, because it already knows how far apart two
 * stations are. viaduct.world records `distance_km` per leg, and the straight
 * line between two points can never exceed the distance travelled between them.
 * A leg whose recorded distance is 9 km but whose endpoints are 1,900 km apart
 * has a station in the wrong place, and says so without anyone looking at a map.
 */

const EARTH_RADIUS_KM = 6371

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in kilometres. */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * How much further apart two stations look than the leg between them was.
 *
 * Positive means the geocode disagrees with the travel record. Rail track is
 * never shorter than the straight line, so a *negative* excess is the normal
 * case and carries no information — Oslo S to Bergen is 484 km of track over
 * about 305 km of air.
 */
export function excessKm(straightLineKm: number, recordedKm: number): number {
  return straightLineKm - recordedKm
}

/**
 * The slack allowed before a leg is called implausible.
 *
 * Generous on purpose. The point is to catch a station on the wrong continent,
 * not to audit the geocoder's metres: ERA5 reads the same ~25 km cell either
 * way, so only a gross error is worth a human's attention. Every real error seen
 * so far was off by hundreds of kilometres, and the tightest legitimate margin
 * measured — a short leg between two well-placed stations — was comfortably
 * inside this.
 */
export const IMPLAUSIBLE_EXCESS_KM = 100

/** True when a leg's endpoints are too far apart for the distance recorded. */
export function isImplausible(straightLineKm: number, recordedKm: number): boolean {
  return excessKm(straightLineKm, recordedKm) > IMPLAUSIBLE_EXCESS_KM
}
