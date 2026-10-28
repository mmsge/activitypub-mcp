import { inArray, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { tripTracks, viaductWaypoints } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import type { GpxProblem, GpxTrack, ViaductGpx } from '../lib/parse-viaduct-gpx.js'

/**
 * Store viaduct.world's GPX export: one geometry per leg and every station waypoint.
 * See ADR 0070.
 *
 * The file is the complete set. A track or waypoint the file no longer contains is
 * deleted, so a leg removed in viaduct loses its line here too. That is only safe because
 * the export is always "all years": a file with no tracks at all is refused rather than
 * read as "delete everything".
 *
 * Nothing here touches `train_trips` or `stations`. The CSV import owns trips and the
 * geocoder owns coordinates; a track joins its trip at query time (`tripTrackMatchSql`).
 */

export interface TripTrackImportReport {
  tracksInFile: number
  waypointsInFile: number
  tracksInserted: number
  tracksUpdated: number
  tracksUnchanged: number
  tracksDeleted: number
  waypointsInserted: number
  waypointsUnchanged: number
  waypointsDeleted: number
  pointsStored: number
  /** Stored tracks that join a `train_trips` row. */
  matched: number
  /** Stored tracks with no trip to join, oldest first. Kept, and listed so they can be fixed. */
  unmatched: { viaductTripId: string; fromStation: string; toStation: string; departureLocal: string }[]
  /** Trips in the archive that have departed and still have no track. */
  departedTripsWithoutTrack: number
  /** Tracks the parser could not read, plus repeated trip ids. */
  problems: GpxProblem[]
}

/**
 * How a track finds its trip: the trip's identity spelled the way the GPX spells it. The
 * GPX desc is the origin's wall clock and so is `departure_local`, so no zone is involved
 * (viaduct's zones are per offset rule, not per station; ADR 0065). One expression, used
 * by the import report and by the tool, so the two cannot disagree about what matched.
 */
export function tripTrackMatchSql(track: string, trip: string): SQL {
  const tt = sql.identifier(track)
  const t = sql.identifier(trip)
  return sql`${tt}.from_station = ${t}.from_station AND ${tt}.to_station = ${t}.to_station AND ${tt}.departure_local = ${t}.departure_local`
}

const waypointKey = (w: { name: string; lat: number; lon: number }) => `${w.name}\u0000${w.lat}\u0000${w.lon}`

/** Insert in slices so a large export never approaches the 65535-parameter cap. */
const CHUNK = 500

export async function importTripTracks(gpx: ViaductGpx): Promise<TripTrackImportReport> {
  if (gpx.tracks.length === 0) {
    // The import replaces the table. A file with nothing in it would empty it, and that
    // is never what uploading an export means.
    throw new Error('The GPX file contains no readable tracks, so nothing was replaced')
  }

  const problems = [...gpx.problems]
  const byId = new Map<string, GpxTrack>()
  for (const t of gpx.tracks) {
    if (byId.has(t.viaductTripId)) {
      problems.push({
        track: `${t.fromStation} → ${t.toStation}`,
        reason: `trip ${t.viaductTripId} appears more than once; the first was kept`,
      })
      continue
    }
    byId.set(t.viaductTripId, t)
  }
  const waypoints = new Map(gpx.waypoints.map((w) => [waypointKey(w), w]))

  const report: TripTrackImportReport = {
    tracksInFile: gpx.tracks.length,
    waypointsInFile: gpx.waypoints.length,
    tracksInserted: 0,
    tracksUpdated: 0,
    tracksUnchanged: 0,
    tracksDeleted: 0,
    waypointsInserted: 0,
    waypointsUnchanged: 0,
    waypointsDeleted: 0,
    pointsStored: 0,
    matched: 0,
    unmatched: [],
    departedTripsWithoutTrack: 0,
    problems,
  }

  const db = getDb()
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: tripTracks.id,
        viaductTripId: tripTracks.viaductTripId,
        fromStation: tripTracks.fromStation,
        toStation: tripTracks.toStation,
        departureLocal: sql<string>`${tripTracks.departureLocal}::text`,
        segments: tripTracks.segments,
      })
      .from(tripTracks)
    const stored = new Map(existing.map((e) => [e.viaductTripId, e]))

    const inserts = []
    for (const [id, t] of byId) {
      const prior = stored.get(id)
      if (!prior) {
        inserts.push(t)
        continue
      }
      const same =
        prior.fromStation === t.fromStation &&
        prior.toStation === t.toStation &&
        prior.departureLocal === t.departureLocal &&
        JSON.stringify(prior.segments) === JSON.stringify(t.segments)
      if (same) {
        report.tracksUnchanged++
        continue
      }
      await tx
        .update(tripTracks)
        .set({
          fromStation: t.fromStation,
          toStation: t.toStation,
          departureLocal: sql`${t.departureLocal}::timestamp`,
          segments: t.segments,
          pointCount: t.pointCount,
          segmentCount: t.segments.length,
          updatedAt: new Date(),
        })
        .where(sql`${tripTracks.id} = ${prior.id}`)
      report.tracksUpdated++
    }
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await tx.insert(tripTracks).values(
        inserts.slice(i, i + CHUNK).map((t) => ({
          viaductTripId: t.viaductTripId,
          fromStation: t.fromStation,
          toStation: t.toStation,
          departureLocal: sql`${t.departureLocal}::timestamp` as never,
          segments: t.segments,
          pointCount: t.pointCount,
          segmentCount: t.segments.length,
        })),
      )
    }
    report.tracksInserted = inserts.length

    const gone = existing.filter((e) => !byId.has(e.viaductTripId))
    for (const e of gone) {
      logger.info(
        { viaductTripId: e.viaductTripId, from: e.fromStation, to: e.toStation, departureLocal: e.departureLocal },
        'Trip track is not in this GPX export; deleted',
      )
    }
    if (gone.length) {
      await tx.delete(tripTracks).where(inArray(tripTracks.id, gone.map((e) => e.id)))
      report.tracksDeleted = gone.length
    }

    const storedWaypoints = await tx
      .select({
        id: viaductWaypoints.id,
        name: viaductWaypoints.name,
        lat: viaductWaypoints.latitude,
        lon: viaductWaypoints.longitude,
      })
      .from(viaductWaypoints)
    const storedKeys = new Set(storedWaypoints.map(waypointKey))
    const newWaypoints = [...waypoints].filter(([k]) => !storedKeys.has(k)).map(([, w]) => w)
    for (let i = 0; i < newWaypoints.length; i += CHUNK) {
      await tx.insert(viaductWaypoints).values(
        newWaypoints.slice(i, i + CHUNK).map((w) => ({ name: w.name, latitude: w.lat, longitude: w.lon })),
      )
    }
    const goneWaypoints = storedWaypoints.filter((w) => !waypoints.has(waypointKey(w)))
    if (goneWaypoints.length) {
      await tx.delete(viaductWaypoints).where(inArray(viaductWaypoints.id, goneWaypoints.map((w) => w.id)))
    }
    report.waypointsInserted = newWaypoints.length
    report.waypointsDeleted = goneWaypoints.length
    report.waypointsUnchanged = waypoints.size - newWaypoints.length
  })

  for (const t of byId.values()) report.pointsStored += t.pointCount

  const unmatched = (await db.execute(sql`
    SELECT tt.viaduct_trip_id, tt.from_station, tt.to_station, tt.departure_local::text AS departure_local
    FROM trip_tracks tt
    WHERE NOT EXISTS (SELECT 1 FROM train_trips t WHERE ${tripTrackMatchSql('tt', 't')})
    ORDER BY tt.departure_local`)) as unknown as Record<string, string>[]
  report.unmatched = unmatched.map((r) => ({
    viaductTripId: r.viaduct_trip_id,
    fromStation: r.from_station,
    toStation: r.to_station,
    departureLocal: r.departure_local,
  }))
  report.matched = byId.size - report.unmatched.length

  const [missing] = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM train_trips t
    WHERE t.departure_at <= now()
      AND NOT EXISTS (SELECT 1 FROM trip_tracks tt WHERE ${tripTrackMatchSql('tt', 't')})`)) as unknown as { n: number }[]
  report.departedTripsWithoutTrack = missing?.n ?? 0

  for (const u of report.unmatched) {
    logger.warn({ ...u }, 'Trip track matches no stored train trip (kept)')
  }
  logger.info(
    {
      tracksInFile: report.tracksInFile,
      tracksInserted: report.tracksInserted,
      tracksUpdated: report.tracksUpdated,
      tracksUnchanged: report.tracksUnchanged,
      tracksDeleted: report.tracksDeleted,
      waypointsInserted: report.waypointsInserted,
      waypointsDeleted: report.waypointsDeleted,
      matched: report.matched,
      unmatched: report.unmatched.length,
      departedTripsWithoutTrack: report.departedTripsWithoutTrack,
      problems: report.problems.length,
    },
    'viaduct GPX import complete',
  )
  return report
}
