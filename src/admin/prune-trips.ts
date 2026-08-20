import { and, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { trainTrips, tripPosts } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { linkTripPosts } from '../jobs/link-trip-posts.js'
import { pruneRefusal, type PruneLimits, type StoredTrip } from '../lib/trip-prune.js'

/**
 * Removing the trips a viaduct export no longer contains.
 *
 * Deliberately not part of `importTrainTrips`, and not reachable by a flag on it: the
 * importer plans a prune on every run and can never apply one, so "the default import
 * writes exactly what it wrote before this feature" is a property of the call graph
 * rather than of a boolean nobody can see from the call site. Only the confirm route
 * gets here, with the ids the admin has just read on the result page.
 *
 * That list is client-supplied, so every guarantee the plan made is re-established
 * here against the live database before anything is deleted — the window, the
 * threshold, and that nothing has been added since the plan was drawn. The posted ids
 * can therefore only ever NARROW what goes. See decision record 0054.
 */

/** Keeps the IN-lists well clear of Postgres' 65535-parameter cap, as link-trip-posts.ts does. */
const CHUNK = 500

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** The configured bounds, in one place, so the plan and the apply cannot disagree. */
export function tripPruneLimits(): PruneLimits {
  return {
    maxShare: config.TRIP_PRUNE_MAX_SHARE,
    minCandidates: config.TRIP_PRUNE_MIN_CANDIDATES,
    minWindow: config.TRIP_PRUNE_MIN_WINDOW,
  }
}

/**
 * `departure_at` rendered as the canonical UTC text both sides of the comparison use.
 * Exported so the incoming side in `import.ts` can be built from the same expression
 * and a test can pin that the two render identically — a stored key in one format and
 * an incoming key in another would make every stored trip a candidate.
 */
export const DEPARTURE_KEY_FORMAT = 'YYYY-MM-DD HH24:MI:SS'

export function departureKeySql(instant: SQL | PgColumn): SQL<string> {
  return sql<string>`to_char(${instant} at time zone 'UTC', ${sql.raw(`'${DEPARTURE_KEY_FORMAT}'`)})`
}

/**
 * Every stored trip inside the export's coverage, candidates and survivors alike —
 * the survivors are what the share is measured against, so both are needed.
 *
 * Bounds are inclusive and go through the query builder rather than a raw template:
 * a bare `Date` does not bind against postgres-js unless drizzle knows the column
 * type (ADR 0023's lesson, repeated here for the same reason).
 * `train_trips_departure_idx` covers the range.
 *
 * `ids` narrows the same read for the confirm route, which must re-establish that
 * every trip it was asked to delete is still inside the window it was reported in.
 */
export function buildStoredInWindowSelect(from: Date, to: Date, ids?: readonly string[]) {
  return getDb()
    .select({
      id: trainTrips.id,
      fromStation: trainTrips.fromStation,
      toStation: trainTrips.toStation,
      key: departureKeySql(trainTrips.departureAt).mapWith(String),
      departureAt: trainTrips.departureAt,
      departureLocal: trainTrips.departureLocal,
      arrivalAt: trainTrips.arrivalAt,
      journey: trainTrips.journey,
      trainCode: trainTrips.trainCode,
      status: trainTrips.status,
      distanceKm: trainTrips.distanceKm,
      createdAt: trainTrips.createdAt,
    })
    .from(trainTrips)
    .where(
      and(
        gte(trainTrips.departureAt, from),
        lte(trainTrips.departureAt, to),
        ids ? inArray(trainTrips.id, ids as string[]) : undefined,
      ),
    )
    .orderBy(trainTrips.departureAt)
}

/**
 * The delete, by primary key and by nothing else.
 *
 * There is no station or departure predicate here on purpose, and a test pins its
 * absence: a mis-built plan can then name the wrong trips, but no statement in this
 * file can ever remove MORE rows than the plan named. `train_trips.id` is also what
 * the three `on delete cascade` foreign keys hang off, so `trip_posts`,
 * `trip_routes` and `trip_line_legs` go with the parent and nothing deletes them
 * by hand.
 */
export function buildTripPruneDelete(ids: readonly string[]) {
  return getDb()
    .delete(trainTrips)
    .where(inArray(trainTrips.id, ids as string[]))
    .returning({
      id: trainTrips.id,
      fromStation: trainTrips.fromStation,
      toStation: trainTrips.toStation,
      departureAt: trainTrips.departureAt,
      departureLocal: trainTrips.departureLocal,
      arrivalAt: trainTrips.arrivalAt,
      journey: trainTrips.journey,
      trainCode: trainTrips.trainCode,
      status: trainTrips.status,
      distanceKm: trainTrips.distanceKm,
      createdAt: trainTrips.createdAt,
    })
}

export interface ApplyPruneInput {
  /** The trips the admin confirmed, from the result page they just read. */
  ids: readonly string[]
  /** The export's coverage, as reported on that page. Re-checked here. */
  window: { from: Date; to: Date }
  /** When the plan was drawn. A trip stored after this was never on the page. */
  derivedAt: Date
}

export interface ApplyPruneResult {
  deleted: number
  /** Set when the threshold refused; nothing was deleted. */
  refusal: string | null
  /** Ids the page offered that this run declined, and why. */
  rejected: { id: string; reason: string }[]
  /** Posts the cascade unbound that the re-derivation did not bind to another trip. */
  orphaned: string[]
}

const NOTHING: ApplyPruneResult = { deleted: 0, refusal: null, rejected: [], orphaned: [] }

export async function applyTripPrune(input: ApplyPruneInput): Promise<ApplyPruneResult> {
  // Never opens a connection for an empty confirm — the shape prune-activity-log.ts
  // uses, and its test pins, so "nothing to do" cannot become a database round trip.
  if (input.ids.length === 0) return NOTHING

  const posted: StoredTrip[] = []
  for (const batch of chunked([...input.ids])) {
    const rows = await buildStoredInWindowSelect(input.window.from, input.window.to, batch)
    posted.push(...(rows as StoredTrip[]))
  }

  const found = new Map(posted.map((t) => [t.id, t]))
  const rejected: { id: string; reason: string }[] = []
  const eligible: StoredTrip[] = []

  for (const id of input.ids) {
    const trip = found.get(id)
    if (!trip) {
      // Either gone already, or outside the window the page reported — the two are
      // indistinguishable from here and neither is something to delete.
      rejected.push({ id, reason: 'no longer stored inside the range the plan covered' })
      continue
    }
    if (trip.createdAt > input.derivedAt) {
      // Re-added in viaduct and re-imported between the two clicks. It was never on
      // the page the admin read, so it is not what they confirmed.
      rejected.push({ id, reason: 'stored after the plan was drawn' })
      continue
    }
    eligible.push(trip)
  }

  if (eligible.length === 0) {
    logger.info({ rejected: rejected.length }, 'Trip prune confirmed, but nothing was eligible')
    return { ...NOTHING, rejected }
  }

  // The threshold is re-applied against the window as it stands NOW, not against the
  // count the page carried: the page is a client, and this is the guard.
  const inWindow = await countTripsInWindow(input.window.from, input.window.to)
  const refusal = pruneRefusal(eligible.length, inWindow, tripPruneLimits())
  if (refusal) {
    logger.warn(
      { candidates: eligible.length, inWindow, from: input.window.from, to: input.window.to },
      `Trip prune refused: ${refusal}`,
    )
    return { deleted: 0, refusal, rejected, orphaned: [] }
  }

  // Read the bindings before the cascade takes them, both to log what went with each
  // trip and to have something to check the re-derivation against afterwards.
  const boundByTrip = await loadBoundPosts(eligible.map((t) => t.id))
  const wasBound = [...boundByTrip.values()].flat()

  let deleted = 0
  for (const batch of chunked(eligible.map((t) => t.id))) {
    const gone = await buildTripPruneDelete(batch)
    deleted += gone.length
    // Logged from what the statement RETURNED, not from what was read a moment ago,
    // so the line provably describes the row that went rather than the row intended.
    // This is the only record a pruned trip leaves — there is no archive table — so
    // it carries everything needed to re-enter it by hand.
    for (const t of gone) {
      logger.info(
        {
          id: t.id,
          from: t.fromStation,
          to: t.toStation,
          departureAt: t.departureAt,
          departureLocal: t.departureLocal,
          arrivalAt: t.arrivalAt,
          journey: t.journey,
          trainCode: t.trainCode,
          status: t.status,
          distanceKm: t.distanceKm,
          createdAt: t.createdAt,
          boundPosts: boundByTrip.get(t.id) ?? [],
        },
        'Trip pruned — the export no longer contains it',
      )
    }
  }

  // The cascade has already unbound those posts. Re-derive so each one lands on the
  // trip it was actually made on — for the Oslo S -> Hamar case, the phantom was
  // holding the togselfie and the real leg gets it back. `objects` is untouched
  // throughout: only the derived link moves (ADR 0023).
  try {
    await linkTripPosts()
  } catch (e) {
    logger.error(e, 'Trip/post re-derivation after a prune failed; the hourly job will retry')
  }

  // The delete and the re-derivation are not one transaction — linkTripPosts() calls
  // getDb() itself, so a transaction here would run it on another pooled connection
  // that cannot see the uncommitted delete, which is worse than not having one. This
  // is what makes the gap visible instead of silent: a post left unbound is either a
  // post with no other trip to be on, which is correct, or the re-derivation not
  // having run, which is not.
  const orphaned = await stillUnbound(wasBound)
  if (orphaned.length > 0) {
    logger.warn(
      { posts: orphaned, of: wasBound.length },
      'Posts unbound by a trip prune were not re-bound to any trip',
    )
  }

  logger.info(
    { deleted, rejected: rejected.length, unbound: wasBound.length, orphaned: orphaned.length },
    'Trip prune complete',
  )
  return { deleted, refusal: null, rejected, orphaned }
}

async function countTripsInWindow(from: Date, to: Date): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(trainTrips)
    .where(and(gte(trainTrips.departureAt, from), lte(trainTrips.departureAt, to)))
  return row?.n ?? 0
}

/** Which posts each doomed trip is holding, before the cascade lets go of them. */
async function loadBoundPosts(tripIds: readonly string[]): Promise<Map<string, string[]>> {
  const byTrip = new Map<string, string[]>()
  for (const batch of chunked([...tripIds])) {
    const rows = await getDb()
      .select({ tripId: tripPosts.tripId, objectApId: tripPosts.objectApId })
      .from(tripPosts)
      .where(inArray(tripPosts.tripId, batch))
    for (const r of rows) byTrip.set(r.tripId, [...(byTrip.get(r.tripId) ?? []), r.objectApId])
  }
  return byTrip
}

/** Of the posts the cascade unbound, the ones the re-derivation did not claim. */
async function stillUnbound(objectApIds: readonly string[]): Promise<string[]> {
  if (objectApIds.length === 0) return []
  const bound = new Set<string>()
  for (const batch of chunked([...objectApIds])) {
    const rows = await getDb()
      .select({ objectApId: tripPosts.objectApId })
      .from(tripPosts)
      .where(inArray(tripPosts.objectApId, batch))
    for (const r of rows) bound.add(r.objectApId)
  }
  return objectApIds.filter((id) => !bound.has(id))
}
