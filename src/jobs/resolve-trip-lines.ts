import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { attributeLeg, defaultRegistry } from '../lib/line-attribution.js'
import { registryVersion } from '../lib/railway-registry.js'

/**
 * Work out which named lines each trip ran on, and cache the answer.
 *
 * Unlike the weather backfill this makes no external call and takes no bounded bite:
 * it is arithmetic over ~230 trips against a registry held in memory, and the whole
 * archive recomputes in milliseconds. So there is no rate limit to honour, no retry
 * bookkeeping, and no partially-migrated state to reason about.
 *
 * What decides whether work happens is `registry_version` — a fingerprint of the
 * registry and its overrides. Move a kilometre post or write an override and every
 * row computed from the old fingerprint is stale at once, so a curation change is
 * always applied to the whole archive or to none of it.
 *
 * Idempotent: a tick with nothing to do writes nothing.
 */

export interface ResolveTripLinesResult {
  /** Trips examined this run — the stale ones, or all of them after a curation change. */
  considered: number
  resolved: number
  /** Two comparable routes, or two lines holding both endpoints. Needs an override. */
  ambiguous: number
  /** No route in the registry — a ferry, or a corner of Europe not yet curated. */
  unresolved: number
  /** Rows written to `trip_line_legs`, crossings included. */
  legs: number
  /** Resolved trips where the registry and the export disagree beyond rounding. */
  scaleSuspect: number
  registryVersion: string
}

interface TripRow {
  id: string
  from_station: string
  to_station: string
  distance_km: number | null
  duration_seconds: number | null
}

export async function resolveTripLines(): Promise<ResolveTripLinesResult> {
  const db = getDb()
  const version = registryVersion()
  const registry = defaultRegistry()

  // Only the trips whose cached answer predates the current registry. On a normal
  // tick that is the newly-imported ones; after a curation change it is all of them.
  const trips = (await db.execute(sql`
    SELECT
      t.id,
      t.from_station,
      t.to_station,
      t.distance_km,
      extract(epoch from (t.arrival_at - t.departure_at))::int AS duration_seconds
    FROM train_trips t
    LEFT JOIN trip_routes r ON r.trip_id = t.id
    WHERE r.id IS NULL OR r.registry_version <> ${version}
    ORDER BY t.departure_at`)) as unknown as TripRow[]

  const result: ResolveTripLinesResult = {
    considered: trips.length,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    legs: 0,
    scaleSuspect: 0,
    registryVersion: version,
  }

  if (trips.length === 0) return result

  for (const trip of trips) {
    const attribution = attributeLeg({
      fromStation: trip.from_station,
      toStation: trip.to_station,
      distanceKm: trip.distance_km == null ? null : Number(trip.distance_km),
      durationSeconds: trip.duration_seconds == null ? null : Number(trip.duration_seconds),
      tripId: trip.id,
    }, registry)

    if (attribution.status === 'resolved') result.resolved++
    else if (attribution.status === 'ambiguous') result.ambiguous++
    else result.unresolved++
    if (attribution.scaleSuspect) result.scaleSuspect++

    // The legs are rewritten wholesale rather than diffed: a re-resolve can drop a
    // line entirely, and a stale row for a line the route no longer touches would be
    // indistinguishable from a real one.
    await db.execute(sql`DELETE FROM trip_line_legs WHERE trip_id = ${trip.id}`)

    for (const leg of attribution.legs) {
      await db.execute(sql`
        INSERT INTO trip_line_legs (trip_id, line_slug, on_line_km, on_line_seconds, crossed)
        VALUES (${trip.id}, ${leg.lineSlug}, ${leg.onLineKm}, ${leg.onLineSeconds}, ${leg.crossed})`)
      result.legs++
    }

    // One explanation field, whichever kind of explanation there is: why a trip could
    // not be placed, or — when curation placed it — the justification for the pinned
    // routing. A number that came from an override has to be able to say so.
    const reason = attribution.overrideReason ?? attribution.reason

    await db.execute(sql`
      INSERT INTO trip_routes (
        trip_id, status, reason, method, raw_km, scale_factor, registry_version, computed_at
      ) VALUES (
        ${trip.id}, ${attribution.status}, ${reason}, ${attribution.method},
        ${attribution.rawKm}, ${attribution.scaleFactor}, ${version}, now()
      )
      ON CONFLICT (trip_id) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        method = EXCLUDED.method,
        raw_km = EXCLUDED.raw_km,
        scale_factor = EXCLUDED.scale_factor,
        registry_version = EXCLUDED.registry_version,
        computed_at = EXCLUDED.computed_at`)
  }

  logger.info(result, 'Resolved trips to railway lines')
  return result
}
