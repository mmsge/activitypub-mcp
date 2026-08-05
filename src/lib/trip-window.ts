/**
 * Which train trip a post was made on.
 *
 * There is no id, geotag or text field linking a post to a trip — the only key is
 * time. It is a sound one: `objects.published_at` and
 * `train_trips.departure_at`/`arrival_at` are all timestamptz, so a comparison
 * holds across the several timezones the 115 stations span.
 *
 * It is also a tight one. Measured against the live archive before this was
 * written, four of four togselfies landed within six minutes of their trip's
 * departure — København H +1m41s, Malmö C +5m39s, Göteborg +14s, Arna +23s. The
 * `#togselfie` habit is a check-in stream that was never recorded as one.
 *
 * Everything here is pure so it can be tested without a database; the job in
 * jobs/link-trip-posts.ts only loads, diffs and writes.
 */

/** The 30 minutes before departure: standing on the platform, photographing the train. */
export const BOARDING_LEAD_MS = 30 * 60 * 1000

/** The 30 minutes after arrival: still on the platform, having got off. */
export const ALIGHTING_TRAIL_MS = 30 * 60 * 1000

/**
 * How long after departure a trip with no recorded arrival still counts as
 * `aboard`. Immediately after departure he is certainly aboard; past this we do
 * not know, and guessing a duration would put a fiction in the table. Such a trip
 * never yields `alighting` — there is no arrival to be after.
 */
export const UNKNOWN_ARRIVAL_ABOARD_MS = 30 * 60 * 1000

export type TripRelation = 'boarding' | 'aboard' | 'alighting'

/** The only trip fields the match depends on. */
export interface TripWindow {
  tripId: string
  departureAt: Date
  /** Nullable in the CSV, and therefore here. */
  arrivalAt: Date | null
}

export interface TripMatch {
  tripId: string
  relation: TripRelation
  /** Signed seconds from departure; negative while still boarding. */
  offsetSeconds: number
}

/** A candidate plus the gap that ranks it: 0 aboard, else seconds outside the window. */
interface Candidate extends TripMatch {
  gap: number
  departureMs: number
}

/**
 * Classify one post against one trip, or null if it falls outside every window.
 *
 * Boundaries are inclusive on the aboard side deliberately: a post stamped at the
 * exact departure second is aboard, not boarding. The Göteborg togselfie above
 * landed 14 seconds after departure, and a rule that put such a post on the
 * platform would mislabel the tightest matches in the archive.
 */
function classify(postMs: number, trip: TripWindow): Candidate | null {
  const departureMs = trip.departureAt.getTime()
  const offsetSeconds = Math.round((postMs - departureMs) / 1000)

  const aboardEndMs = trip.arrivalAt
    ? trip.arrivalAt.getTime()
    : departureMs + UNKNOWN_ARRIVAL_ABOARD_MS

  // An arrival recorded as before its departure is corrupt data, not a zero-length
  // trip: treat the trip as unbounded-unknown rather than matching nothing at all.
  const end = Math.max(aboardEndMs, departureMs)

  if (postMs >= departureMs && postMs <= end) {
    return { tripId: trip.tripId, relation: 'aboard', offsetSeconds, gap: 0, departureMs }
  }
  if (postMs < departureMs && departureMs - postMs <= BOARDING_LEAD_MS) {
    return {
      tripId: trip.tripId,
      relation: 'boarding',
      offsetSeconds,
      gap: departureMs - postMs,
      departureMs,
    }
  }
  // Only a trip with a real arrival can be alighted from. Where arrival is
  // unknown the window above already covered the certain part.
  if (trip.arrivalAt && postMs > end && postMs - end <= ALIGHTING_TRAIL_MS) {
    return { tripId: trip.tripId, relation: 'alighting', offsetSeconds, gap: postMs - end, departureMs }
  }
  return null
}

/**
 * The single trip a post belongs to, or null.
 *
 * Consecutive legs overlap at the edges — Roskilde→Næstved arrives 17:01 and
 * Næstved→København departs 17:10, so a post at 17:05 is in both windows. The
 * ranking is total, so the answer is stable across runs: aboard beats an edge,
 * then the smallest gap, then the earlier departure, then the id.
 */
export function matchTrip(postAt: Date, trips: readonly TripWindow[]): TripMatch | null {
  const postMs = postAt.getTime()
  let best: Candidate | null = null

  for (const trip of trips) {
    const c = classify(postMs, trip)
    if (!c) continue
    if (!best || better(c, best)) best = c
  }

  if (!best) return null
  return { tripId: best.tripId, relation: best.relation, offsetSeconds: best.offsetSeconds }
}

function better(a: Candidate, b: Candidate): boolean {
  const aAboard = a.relation === 'aboard' ? 0 : 1
  const bAboard = b.relation === 'aboard' ? 0 : 1
  if (aAboard !== bAboard) return aAboard < bAboard
  if (a.gap !== b.gap) return a.gap < b.gap
  if (a.departureMs !== b.departureMs) return a.departureMs < b.departureMs
  return a.tripId < b.tripId
}

/** The widest instant either edge of a trip set can reach, for narrowing the post query. */
export function candidateWindow(
  trips: readonly TripWindow[],
): { from: Date; to: Date } | null {
  if (trips.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const t of trips) {
    const dep = t.departureAt.getTime()
    const end = t.arrivalAt
      ? Math.max(t.arrivalAt.getTime(), dep) + ALIGHTING_TRAIL_MS
      : dep + UNKNOWN_ARRIVAL_ABOARD_MS
    if (dep - BOARDING_LEAD_MS < min) min = dep - BOARDING_LEAD_MS
    if (end > max) max = end
  }
  return { from: new Date(min), to: new Date(max) }
}

// ---- diffing the derived set against what is stored -------------------------

export interface StoredLink {
  objectApId: string
  tripId: string
  relation: string
  offsetSeconds: number
}

export interface DesiredLink extends TripMatch {
  objectApId: string
}

export interface LinkPlan {
  toInsert: DesiredLink[]
  toUpdate: DesiredLink[]
  /** `object_ap_id`s whose stored link no longer matches any trip. */
  toDelete: string[]
}

/**
 * Diff desired links against stored ones so a re-run writes only what changed.
 *
 * `stored` must be the links for the same candidate set `desired` was computed
 * from — otherwise every link outside the window looks stale and gets deleted.
 */
export function planTripPostLinks(
  desired: readonly DesiredLink[],
  stored: readonly StoredLink[],
): LinkPlan {
  const storedBy = new Map(stored.map((s) => [s.objectApId, s]))
  const plan: LinkPlan = { toInsert: [], toUpdate: [], toDelete: [] }

  for (const d of desired) {
    const s = storedBy.get(d.objectApId)
    if (!s) {
      plan.toInsert.push(d)
    } else if (
      s.tripId !== d.tripId ||
      s.relation !== d.relation ||
      s.offsetSeconds !== d.offsetSeconds
    ) {
      plan.toUpdate.push(d)
    }
  }

  const desiredIds = new Set(desired.map((d) => d.objectApId))
  for (const s of stored) {
    if (!desiredIds.has(s.objectApId)) plan.toDelete.push(s.objectApId)
  }

  return plan
}
