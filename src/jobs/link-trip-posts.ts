import { and, gte, lte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { objects, trainTrips, tripPosts } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { resolveActorIds } from '../stream/query.js'
import {
  matchTrip,
  candidateWindow,
  planTripPostLinks,
  type TripWindow,
  type DesiredLink,
  type StoredLink,
} from '../lib/trip-window.js'

/**
 * Bind each of Markus' posts to the train trip it was posted on.
 *
 * The two sides share nothing but a timeline, and that turns out to be enough:
 * togselfies land within seconds of their trip's departure (see ADR 0022). This
 * job walks the join and writes `trip_posts`.
 *
 * Deliberately computed in JS rather than as one SQL statement, unlike
 * derive-garden-dates.ts. The ranking that resolves overlapping legs is the whole
 * decision here, and it is worth having under unit test as a pure function rather
 * than buried in a window clause; 229 trips against a few thousand candidate posts
 * is nowhere near enough data to pay for the SQL.
 *
 * Scoped to the STREAM_SOURCES allowlist, not to `objects` at large. `objects` is
 * not "Markus' posts": the Announce handler files a boosted post under its
 * original author, so an unscoped join would put a stranger's post on his train.
 *
 * Every statement goes through the query builder rather than a raw `sql` template.
 * That is not stylistic: `db.execute(sql\`… = ANY(${ids})\`)` flattens the array
 * into positional parameters, so it silently works for one actor and breaks for
 * two, and a bare Date parameter fails to bind at all against postgres-js. The
 * builder knows the column types and gets both right.
 */

export interface LinkTripPostsResult {
  /** Links written for the first time. */
  inserted: number
  /** Links whose trip, relation or offset changed. */
  updated: number
  /** Links dropped because the post no longer falls in any trip window. */
  deleted: number
  /** Posts considered — those inside the widest reach of any trip. */
  candidates: number
  /** Distinct trips that ended up with at least one post. */
  tripsWithPosts: number
}

const EMPTY: LinkTripPostsResult = {
  inserted: 0, updated: 0, deleted: 0, candidates: 0, tripsWithPosts: 0,
}

/** Keeps the upsert and the IN-lists well clear of Postgres' 65535-parameter cap. */
const CHUNK = 500

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function linkTripPosts(): Promise<LinkTripPostsResult> {
  const db = getDb()

  const tripRows = await db
    .select({ id: trainTrips.id, departureAt: trainTrips.departureAt, arrivalAt: trainTrips.arrivalAt })
    .from(trainTrips)

  const trips: TripWindow[] = tripRows.map((r) => ({
    tripId: r.id,
    departureAt: r.departureAt,
    arrivalAt: r.arrivalAt,
  }))

  const window = candidateWindow(trips)
  if (!window) {
    logger.info(EMPTY, 'No train trips stored; nothing to link')
    return EMPTY
  }

  const actorIds = await resolveActorIds()
  const ownActorIds = Object.values(actorIds).flat()
  if (ownActorIds.length === 0) {
    // No allowlist resolved: link nothing rather than fall back to every actor in
    // the archive, which would bind strangers' boosted posts to Markus' trips.
    logger.warn(EMPTY, 'No STREAM_SOURCES actors resolved; skipping trip/post linking')
    return EMPTY
  }

  // Only posts that could possibly match: inside the widest reach of any trip.
  // Over the 2016–2026 span that is a small slice of the 5,000+ stored posts.
  const postRows = await db
    .select({ apId: objects.apId, publishedAt: objects.publishedAt })
    .from(objects)
    .where(and(
      isNull(objects.deletedAt),
      isNotNull(objects.publishedAt),
      gte(objects.publishedAt, window.from),
      lte(objects.publishedAt, window.to),
      inArray(objects.actorApId, ownActorIds),
    ))

  const desired: DesiredLink[] = []
  for (const p of postRows) {
    if (!p.publishedAt) continue
    const match = matchTrip(p.publishedAt, trips)
    if (match) desired.push({ objectApId: p.apId, ...match })
  }

  // Compare against the stored links for the same candidate set. Reading all of
  // `trip_posts` instead would mark every link outside the window as stale.
  const candidateIds = postRows.map((p) => p.apId)
  const stored: StoredLink[] = []
  for (const batch of chunked(candidateIds)) {
    const rows = await db
      .select({
        objectApId: tripPosts.objectApId,
        tripId: tripPosts.tripId,
        relation: tripPosts.relation,
        offsetSeconds: tripPosts.offsetSeconds,
      })
      .from(tripPosts)
      .where(inArray(tripPosts.objectApId, batch))
    stored.push(...rows)
  }

  const plan = planTripPostLinks(desired, stored)

  // Inserts and updates go through one upsert: `object_ap_id` is unique, so the
  // conflict target is exactly the "one trip per post" invariant. The plan's split
  // between the two is kept for the log, which is how a surprising re-derivation
  // becomes visible.
  const toWrite = [...plan.toInsert, ...plan.toUpdate]
  for (const batch of chunked(toWrite)) {
    await db
      .insert(tripPosts)
      .values(batch.map((l) => ({
        tripId: l.tripId,
        objectApId: l.objectApId,
        relation: l.relation,
        offsetSeconds: l.offsetSeconds,
      })))
      .onConflictDoUpdate({
        target: tripPosts.objectApId,
        set: {
          tripId: sql`excluded.trip_id`,
          relation: sql`excluded.relation`,
          offsetSeconds: sql`excluded.offset_seconds`,
          derivedAt: sql`now()`,
        },
      })
  }

  for (const batch of chunked(plan.toDelete)) {
    await db.delete(tripPosts).where(inArray(tripPosts.objectApId, batch))
  }

  const result: LinkTripPostsResult = {
    inserted: plan.toInsert.length,
    updated: plan.toUpdate.length,
    deleted: plan.toDelete.length,
    candidates: postRows.length,
    tripsWithPosts: new Set(desired.map((d) => d.tripId)).size,
  }
  logger.info(result, 'Posts bound to the trips they were posted on')
  return result
}
