import { eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { getDb } from '../db/client.js'
import { activities, actors, linkedinPostMetrics, trainTrips, tripRoutes } from '../db/schema.js'
import { processActivity } from '../activitypub/inbox.js'
import { fetchActor } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'
import type { LinkedinExport } from '../lib/parse-linkedin-export.js'
import type { TripRow } from '../lib/parse-trips-csv.js'
import { linkTripPosts } from '../jobs/link-trip-posts.js'

type AnyObject = Record<string, unknown>

export interface ImportResult {
  total: number
  imported: number
  skipped: number
  errors: string[]
}

const MAX_OUTBOX_PAGES = 200
const OUTBOX_PAGE_DELAY_MS = 300

function resolveActorId(activity: AnyObject): string | null {
  const raw = activity.actor ?? activity.attributedTo
  if (typeof raw === 'string') return raw
  if (raw && typeof (raw as AnyObject).id === 'string') return (raw as AnyObject).id as string
  return null
}

export async function storeAndProcessImported(
  activity: AnyObject,
): Promise<{ skipped: boolean; error?: string }> {
  const apId = activity.id as string | undefined
  const type = activity.type as string | undefined

  if (!apId || !type) return { skipped: true }

  const actorApId = resolveActorId(activity)
  if (!actorApId) return { skipped: true }

  const db = getDb()
  const obj = activity.object as AnyObject | string | null
  const objectApId =
    typeof obj === 'string' ? obj : ((obj as AnyObject)?.id as string) ?? null
  const objectType =
    typeof obj === 'object' && obj
      ? ((obj as AnyObject).type as string) ?? null
      : null

  const result = await db
    .insert(activities)
    .values({
      apId,
      type,
      actorApId,
      objectApId,
      objectType,
      raw: activity,
    })
    .onConflictDoNothing()
    .returning({ apId: activities.apId })

  if (result.length === 0) return { skipped: true }

  try {
    await processActivity(activity)
    await db
      .update(activities)
      .set({ processed: true })
      .where(eq(activities.apId, apId))
    return { skipped: false }
  } catch (e) {
    const msg = String(e)
    await db
      .update(activities)
      .set({ processingError: msg })
      .where(eq(activities.apId, apId))
    return { skipped: false, error: `${apId}: ${msg}` }
  }
}

export async function processActivityBatch(
  items: unknown[],
  onProgress?: (n: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { total: items.length, imported: 0, skipped: 0, errors: [] }

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as AnyObject
    const outcome = await storeAndProcessImported(item)
    if (outcome.skipped) {
      result.skipped++
    } else if (outcome.error) {
      result.imported++
      if (result.errors.length < 50) result.errors.push(outcome.error)
    } else {
      result.imported++
    }
    if (onProgress && (i + 1) % 50 === 0) onProgress(i + 1)
  }

  return result
}

export function parseMastodonArchive(text: string): unknown[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('File is not valid JSON')
  }
  const obj = data as AnyObject
  if (obj.type !== 'OrderedCollection') {
    throw new Error(`Expected an OrderedCollection, got: ${obj.type ?? 'unknown'}`)
  }
  const items = obj.orderedItems
  if (!Array.isArray(items)) {
    throw new Error('OrderedCollection has no orderedItems array')
  }
  return items
}

export async function crawlOutbox(actorUrl: string): Promise<unknown[]> {
  const db = getDb()
  const actorRows = await db
    .select()
    .from(actors)
    .where(eq(actors.apId, actorUrl))
    .limit(1)

  let outboxUrl: string
  if (actorRows.length > 0 && (actorRows[0].raw as AnyObject)?.outbox) {
    outboxUrl = (actorRows[0].raw as AnyObject).outbox as string
  } else {
    outboxUrl = `${actorUrl}/outbox`
  }

  const AP_HEADERS = {
    Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  }

  const allItems: unknown[] = []
  let pagesFetched = 0

  async function fetchPage(url: string): Promise<void> {
    if (pagesFetched >= MAX_OUTBOX_PAGES) {
      logger.warn({ url }, `Outbox crawl hit page limit (${MAX_OUTBOX_PAGES}), stopping`)
      return
    }
    const res = await fetch(url, { headers: AP_HEADERS })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    const data = (await res.json()) as AnyObject
    pagesFetched++

    const items = data.orderedItems as unknown[] | undefined
    if (Array.isArray(items)) {
      allItems.push(...items)
    }

    let nextUrl: string | undefined
    if (pagesFetched === 1 && !items) {
      // Root collection without inline items — follow first
      const first = data.first
      if (typeof first === 'string') nextUrl = first
      else if (first && typeof (first as AnyObject).id === 'string')
        nextUrl = (first as AnyObject).id as string
    } else {
      const next = data.next
      if (typeof next === 'string') nextUrl = next
    }

    if (nextUrl) {
      await new Promise((r) => setTimeout(r, OUTBOX_PAGE_DELAY_MS))
      await fetchPage(nextUrl)
    }
  }

  await fetchPage(outboxUrl)
  logger.info({ actorUrl, pages: pagesFetched, items: allItems.length }, 'Outbox crawl complete')
  return allItems
}

export interface TripImportResult {
  total: number
  inserted: number
  /** Matched an existing trip and carried something new into it. */
  updated: number
  /** Matched an existing trip and had nothing to add, or repeated a row in the file. */
  unchanged: number
}

/**
 * Attributes of a trip, as opposed to the trip itself — every one of them may arrive
 * better on a later export. `coalesce(excluded.c, stored.c)` throughout: an incoming
 * null is silence, not an erasure, so an export that happens not to name the operator
 * leaves the stored one alone.
 *
 * `status` is in this list rather than beside it because the rule is the same one:
 * the incoming value wins, and only a null defers. That is what moves a leg from
 * Planned to Completed on re-export, which ADR 0031 recorded as impossible.
 *
 * `trainCode` is here too, and that is the point of ADR 0048 — it used to be half the
 * identity, which is why the same journey was stored twice.
 */
const REFRESHABLE = [
  'journey', 'trainCode', 'lineNumber', 'trainName', 'operator', 'mode', 'travelClass',
  'seatType', 'seat', 'coach', 'reason', 'continent', 'notes', 'ticket',
  'distanceKm', 'delay', 'departureDelay', 'price', 'savings', 'currency', 'tags',
  'status',
] as const

/** NOT NULL DEFAULT false, so an absent flag reads as false and there is no null to
 *  coalesce through. Any export claiming the amenity carries it. */
const AMENITIES = ['cycling', 'wifi', 'diningCar', 'night', 'replacement', 'reservation'] as const

const incoming = (col: PgColumn): SQL => sql`excluded.${sql.identifier(col.name)}`

/**
 * The upsert's SET clause and the guard that keeps a repeat import from writing at all,
 * built from one pass over the same column lists so the two cannot drift apart. Without
 * the guard, re-importing an unchanged export would rewrite every row with its own
 * values — no visible difference, but not the no-op the import claims to be.
 */
export function tripUpsertRules(): { set: Record<string, SQL>; setWhere: SQL } {
  const set: Record<string, SQL> = {}
  const changed: SQL[] = []
  const rule = (key: string, col: PgColumn, next: SQL) => {
    set[key] = next
    changed.push(sql`${next} is distinct from ${col}`)
  }

  for (const key of REFRESHABLE) {
    const col = trainTrips[key] as PgColumn
    rule(key, col, sql`coalesce(${incoming(col)}, ${col})`)
  }
  for (const key of AMENITIES) {
    const col = trainTrips[key] as PgColumn
    rule(key, col, sql`(${col} or ${incoming(col)})`)
  }

  // Arrival moves as a unit, keyed on the incoming instant being present, so the wall
  // clock, the instant and the zone it was computed in can never come from different
  // exports and disagree.
  const hasArrival = sql`${incoming(trainTrips.arrivalAt)} is not null`
  for (const key of ['arrivalAt', 'arrivalLocal', 'toTz'] as const) {
    const col = trainTrips[key] as PgColumn
    rule(key, col, sql`case when ${hasArrival} then ${incoming(col)} else ${col} end`)
  }

  // Provenance follows the newest export rather than being merged: `raw` says where the
  // current status came from, and a spliced-together row would describe no export that
  // was ever delivered.
  rule('raw', trainTrips.raw as PgColumn, incoming(trainTrips.raw as PgColumn))

  return { set, setWhere: sql.join(changed, sql` or `) }
}

/**
 * The identity upsert, built without touching the connection so its shape can be
 * asserted in a test. A trip IS `(from_station, to_station, departure_at)` — see
 * ADR 0048 and the unique index the target names.
 */
export function buildTrainTripsUpsert(values: unknown[]) {
  const { set, setWhere } = tripUpsertRules()
  return getDb()
    .insert(trainTrips)
    .values(values as never)
    .onConflictDoUpdate({
      target: [trainTrips.fromStation, trainTrips.toStation, trainTrips.departureAt],
      set: set as never,
      setWhere,
    })
    .returning({
      id: trainTrips.id,
      fromStation: trainTrips.fromStation,
      toStation: trainTrips.toStation,
      departureAt: trainTrips.departureAt,
      journey: trainTrips.journey,
      trainCode: trainTrips.trainCode,
      status: trainTrips.status,
      // `xmax` is 0 on a tuple this statement inserted and the current xid on one it
      // updated — the only way to tell an insert from a match after the fact.
      inserted: sql<boolean>`(xmax = 0)`,
    })
}

/**
 * Import parsed train trips, updating a matching trip in place rather than storing it
 * twice. Absolute instants are computed in Postgres from the local wall-clock + IANA
 * zone so DST and overnight legs resolve correctly. Re-importing the same export writes
 * nothing at all.
 */
export async function importTrainTrips(rows: TripRow[]): Promise<TripImportResult> {
  const total = rows.length
  if (total === 0) return { total: 0, inserted: 0, updated: 0, unchanged: 0 }

  // Drop in-file duplicates so the single statement never reaches the same stored row
  // twice — Postgres rejects that outright ("ON CONFLICT DO UPDATE command cannot affect
  // row a second time"). Keyed on what `departure_at` is derived from, which is the
  // identity tuple spelled in the columns the CSV actually carries.
  const seen = new Set<string>()
  const unique = rows.filter((r) => {
    const key = [r.fromStation, r.toStation, r.departureLocal, r.fromTz].join(' ')
    return seen.has(key) ? false : (seen.add(key), true)
  })

  const assumed = rows.filter((r) => r.tzAssumed).length
  if (assumed > 0) {
    // Identity is compared on the instant, so an export that stopped naming the origin
    // zone would shift every departure by the local offset and split each trip in two.
    logger.warn(
      { rows: assumed, of: total, assumed: 'UTC' },
      'Trip rows named no origin timezone; the assumed zone decides their departure instant',
    )
  }

  const db = getDb()
  const values = unique.map((r) => ({
    fromStation: r.fromStation,
    toStation: r.toStation,
    journey: r.journey,
    trainCode: r.trainCode,
    lineNumber: r.lineNumber,
    trainName: r.trainName,
    operator: r.operator,
    mode: r.mode,
    travelClass: r.travelClass,
    seatType: r.seatType,
    seat: r.seat,
    coach: r.coach,
    reason: r.reason,
    continent: r.continent,
    notes: r.notes,
    ticket: r.ticket,
    departureLocal: sql`${r.departureLocal}::timestamp`,
    arrivalLocal: r.arrivalLocal ? sql`${r.arrivalLocal}::timestamp` : null,
    fromTz: r.fromTz,
    toTz: r.toTz,
    departureAt: sql`(${r.departureLocal}::timestamp AT TIME ZONE ${r.fromTz})`,
    arrivalAt: r.arrivalLocal ? sql`(${r.arrivalLocal}::timestamp AT TIME ZONE ${r.toTz})` : null,
    distanceKm: r.distanceKm,
    delay: r.delay,
    departureDelay: r.departureDelay,
    price: r.price,
    savings: r.savings,
    currency: r.currency,
    cycling: r.cycling,
    wifi: r.wifi,
    diningCar: r.diningCar,
    night: r.night,
    replacement: r.replacement,
    reservation: r.reservation,
    status: r.status,
    tags: r.tags,
    raw: r.raw,
  }))

  const written = await buildTrainTripsUpsert(values)

  // One line per row that actually moved. Verbose on purpose for the first import after
  // ADR 0048: a leg that inserts when it should have matched is the failure this change
  // is guarding against, and it is only cheap to spot if it was logged.
  for (const w of written) {
    logger.info(
      {
        id: w.id,
        from: w.fromStation,
        to: w.toStation,
        departureAt: w.departureAt,
        journey: w.journey,
        trainCode: w.trainCode,
        status: w.status,
      },
      w.inserted ? 'Trip inserted' : 'Trip matched an existing record and was updated',
    )
  }

  const inserted = written.filter((w) => w.inserted).length
  const updated = written.length - inserted

  // A matched trip keeps its id, so its cached route survives — and may now be scaled
  // against a distance that just changed. resolveTripLines only revisits a trip whose
  // trip_routes row is missing or predates the current registry version, so without this
  // nothing would ever recompute `scale_factor` or the per-line kilometres.
  const updatedIds = written.filter((w) => !w.inserted).map((w) => w.id)
  if (updatedIds.length > 0) {
    await db.delete(tripRoutes).where(inArray(tripRoutes.tripId, updatedIds))
  }

  // New trips can claim posts already in the archive, and a refreshed arrival moves an
  // existing trip's window, so re-derive now rather than leaving the join an hour stale.
  // Non-fatal: the import succeeded either way, and the hourly tick will pick it up.
  if (written.length > 0) {
    try {
      await linkTripPosts()
    } catch (e) {
      logger.error(e, 'Trip/post linking after import failed; the hourly job will retry')
    }
  }

  // Rows repeated within the file collapse into whichever copy was written, so they land
  // in `unchanged` alongside the trips that had nothing new to offer.
  return { total, inserted, updated, unchanged: total - inserted - updated }
}

export interface LinkedinImportResult {
  total: number
  inserted: number
  skipped: number
  exportDate: string
}

/**
 * Store one month's LinkedIn metrics. Append-only, and idempotent on
 * (post key, export date).
 *
 * Nothing here updates: the export's impressions are a windowed accumulation
 * rather than a lifetime total, so a later export of the same post is a genuinely
 * different observation, not a correction of the earlier one. Overwriting would
 * discard the difference between them, which is the whole reach-decay series.
 * Successive exports therefore accumulate, and the unique index is what makes
 * re-uploading the same file a no-op instead of a duplicate.
 *
 * Rows are stored even when no `linkedin_posts` row exists yet — a post the poller
 * has not reached is still a real measurement, and the poller will backfill the
 * content later. That is why there is no foreign key. See ADR 0033.
 */
export async function importLinkedinMetrics(
  parsed: LinkedinExport,
): Promise<LinkedinImportResult> {
  const total = parsed.metrics.length
  if (total === 0) {
    return { total: 0, inserted: 0, skipped: 0, exportDate: parsed.exportDate }
  }

  // Drop in-file duplicates so the single INSERT has no repeated conflict targets.
  const seen = new Set<string>()
  const unique = parsed.metrics.filter(
    (m) => (seen.has(m.postKey) ? false : (seen.add(m.postKey), true)),
  )

  const db = getDb()
  const values = unique.map((m) => ({
    postKey: m.postKey,
    postUrl: m.postUrl,
    exportDate: parsed.exportDate,
    windowStart: parsed.windowStart,
    windowEnd: parsed.windowEnd,
    postedOn: m.postedOn,
    impressions: m.impressions,
    engagements: m.engagements,
    raw: m.raw,
  }))

  const inserted = await db
    .insert(linkedinPostMetrics)
    .values(values as any)
    .onConflictDoNothing({
      target: [linkedinPostMetrics.postKey, linkedinPostMetrics.exportDate],
    })
    .returning({ id: linkedinPostMetrics.id })

  return {
    total,
    inserted: inserted.length,
    skipped: total - inserted.length,
    exportDate: parsed.exportDate,
  }
}

export async function ensureActor(actorUrl: string): Promise<void> {
  await fetchActor(actorUrl)
}

export const BARE_OBJECT_TYPES = [
  'Note', 'Article', 'Image', 'Video', 'Audio', 'Page', 'Event',
  'Review', 'Rating', 'ReadThrough', 'Edition', 'Work', 'ShelfBook', 'Comment', 'GeneratedNote',
]

export async function reprocessActivitiesByType(
  types: string[],
  onProgress?: (n: number) => void,
): Promise<ImportResult> {
  const db = getDb()
  const rows = await db.select().from(activities).where(inArray(activities.type, types))
  const result: ImportResult = { total: rows.length, imported: 0, skipped: 0, errors: [] }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      await processActivity(row.raw as AnyObject)
      await db.update(activities)
        .set({ processed: true, processingError: null })
        .where(eq(activities.apId, row.apId))
      result.imported++
    } catch (e) {
      const msg = String(e)
      await db.update(activities)
        .set({ processingError: msg })
        .where(eq(activities.apId, row.apId))
      if (result.errors.length < 50) result.errors.push(`${row.apId}: ${msg}`)
    }
    if (onProgress && (i + 1) % 50 === 0) onProgress(i + 1)
  }

  return result
}
