/**
 * What a viaduct export says is gone.
 *
 * ADR 0048 made a trip an identity — `(from_station, to_station, departure_at)` — and
 * made a re-export improve a stored trip rather than duplicate it. It said nothing
 * about absence, because absence had never been a signal: the importer inserts and
 * updates and has no third verb. So a leg deleted in viaduct, or one whose departure
 * time was corrected there, survives in the archive forever and the corrected copy
 * arrives beside it.
 *
 * A CSV carries no tombstones. Absence is the only deletion signal there is, and it
 * only means anything where the file has coverage — a filtered or truncated export is
 * nothing BUT absence. Everything here exists to keep that asymmetry honest:
 *
 * - **Only inside the export's own range.** The window is the earliest and latest
 *   departure in the file. A partial export cannot reach past what it describes.
 * - **Refuse when the deletions look like a bad file.** A share of the window, with a
 *   small-count floor that is itself gated on the window being populated.
 *
 * Everything is pure so it can be tested without a database, the way `trip-window.ts`
 * is; `admin/import.ts` and `admin/prune-trips.ts` only load and write. See decision
 * record 0054.
 */

/**
 * A trip's identity, with the departure rendered as canonical UTC text.
 *
 * Text, not a `Date`, and rendered by Postgres on BOTH sides. `departure_at` is
 * computed in Postgres from a wall clock and an IANA zone (ADR 0048 is emphatic that
 * JS must not duplicate that), so the incoming side has to be resolved by a query
 * too — and the moment one side is a `Date` and the other a timestamptz literal,
 * every stored trip becomes a candidate. Comparing strings removes the coupling to
 * driver type parsing entirely. It also rules out the obvious repair: a Postgres
 * timestamptz literal is not ISO-8601, so `new Date()` on one is unsound.
 */
export interface TripIdentity {
  fromStation: string
  toStation: string
  /** `YYYY-MM-DD HH24:MI:SS`, UTC. */
  key: string
}

/** A stored trip, carrying what the prune log line and the result page need. */
export interface StoredTrip extends TripIdentity {
  id: string
  departureAt: Date
  departureLocal: Date
  arrivalAt: Date | null
  journey: string | null
  trainCode: string | null
  status: string | null
  distanceKm: number | null
  createdAt: Date
}

export interface PruneLimits {
  /** Fraction of the window that may be removed, e.g. 0.2. */
  maxShare: number
  /** This many deletions always pass — but only in a populated window. */
  minCandidates: number
  /** How many stored trips the window must hold before the floor applies. */
  minWindow: number
}

export interface PruneWindow {
  from: Date
  to: Date
  fromKey: string
  toKey: string
}

export interface PrunePlan {
  /** Null when the export named no trips at all: nothing is eligible. */
  window: PruneWindow | null
  /** Trips stored inside the window, candidates included. */
  inWindow: number
  candidates: StoredTrip[]
  /** Null when the prune may proceed; a sentence naming the numbers when it may not. */
  refusal: string | null
}

/**
 * The identity tuple as one comparable string. Both sides build it the same way.
 *
 * The separator is a NUL rather than a space because station names contain spaces:
 * joined on one, `Oslo` -> `S Hamar` and `Oslo S` -> `Hamar` collapse into the same
 * key, and one of the two would be pruned as absent from an export that names it.
 */
const SEP = '\u0000'

export function identityKey(t: TripIdentity): string {
  return `${t.fromStation}${SEP}${t.toStation}${SEP}${t.key}`
}

/**
 * Whether a plan of this size may be applied, and if not, why — as a finished
 * sentence, so the result page needs no formatting logic of its own and the confirm
 * route re-applies the identical rule rather than a second copy of it.
 *
 * Deleting nothing is never a refusal. Above that the share decides; the floor can
 * only ever let MORE through, and only in a window big enough for the floor to be a
 * small number. That gate is the whole point of it: without it a two-leg export over
 * a four-trip window would remove half the window on the strength of `2 <= 3`.
 */
export function pruneRefusal(
  candidates: number,
  inWindow: number,
  limits: PruneLimits,
): string | null {
  if (candidates <= 0) return null
  // Unreachable while candidates are drawn from the window, but the share below would
  // be NaN and every NaN comparison is quietly false — which would read as "allowed".
  if (inWindow <= 0) return null

  // Strictly more than the share refuses, so 20 of 100 passes at 0.2 and 21 does not.
  const allowed = Math.floor(limits.maxShare * inWindow)
  if (candidates <= allowed) return null
  if (inWindow >= limits.minWindow && candidates <= limits.minCandidates) return null

  const share = Math.round((candidates / inWindow) * 100)
  const ceiling = Math.round(limits.maxShare * 100)
  return (
    `${candidates} of the ${inWindow} trips stored in this export's range are missing ` +
    `from it (${share}%), above the ${ceiling}% ceiling. That looks like a partial ` +
    `export rather than a correction, so nothing was pruned.`
  )
}

/**
 * The trips inside the export's range that the export does not contain.
 *
 * `storedInWindow` must already be bounded by the window this returns — the caller
 * computes the window from `incoming`, reads the stored side with it, then calls here.
 * Two steps rather than one because the window is what makes the stored read small,
 * and because that read is the only part of this needing a connection.
 */
export function planTripPrune(
  incoming: readonly TripIdentity[],
  storedInWindow: readonly StoredTrip[],
  limits: PruneLimits,
): PrunePlan {
  const window = pruneWindow(incoming)
  if (!window) {
    return { window: null, inWindow: 0, candidates: [], refusal: null }
  }

  const present = new Set(incoming.map(identityKey))
  const candidates = storedInWindow.filter((t) => !present.has(identityKey(t)))

  return {
    window,
    inWindow: storedInWindow.length,
    candidates,
    refusal: pruneRefusal(candidates.length, storedInWindow.length, limits),
  }
}

/**
 * The export's own coverage: earliest to latest departure in the file, inclusive at
 * both ends. A pure function of the file and nothing else, which is the guarantee a
 * truncated export leans on — no stored row can widen it.
 *
 * `Date`s for the query, keys for the report: the query builder wants a bound `Date`
 * (a bare one fails against postgres-js unless drizzle knows the column type, the
 * lesson in `link-trip-posts.ts`) and the page shows the text.
 *
 * Keys sort lexicographically because they are fixed-width UTC, which is the whole
 * reason the format is `YYYY-MM-DD HH24:MI:SS` and not something friendlier.
 */
export function pruneWindow(incoming: readonly TripIdentity[]): PruneWindow | null {
  if (incoming.length === 0) return null

  let fromKey = incoming[0].key
  let toKey = incoming[0].key
  for (const t of incoming) {
    if (t.key < fromKey) fromKey = t.key
    if (t.key > toKey) toKey = t.key
  }

  return { from: parseKey(fromKey), to: parseKey(toKey), fromKey, toKey }
}

/**
 * `YYYY-MM-DD HH24:MI:SS` in UTC to the instant, by parts — never `new Date(key)`,
 * which is the trap `TripIdentity` names: the string is not ISO-8601 and parsing a
 * non-ISO date is implementation-defined.
 */
function parseKey(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(key)
  if (!m) throw new Error(`Not a canonical UTC departure key: ${key}`)
  const [, y, mo, d, h, mi, s] = m
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
}
