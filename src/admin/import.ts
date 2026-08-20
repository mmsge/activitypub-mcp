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
import {
  identityKey,
  planTripPrune,
  pruneWindow,
  type PrunePlan,
  type StoredTrip,
  type TripIdentity,
} from '../lib/trip-prune.js'
import {
  buildStoredInWindowSelect,
  departureKeySql,
  tripPruneLimits,
} from './prune-trips.js'

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
  /**
   * The trips stored inside this export's range that the export does not contain.
   * Reported here and removed nowhere: applying a plan is `applyTripPrune`, which the
   * confirm route reaches and the import never does. See decision record 0054.
   */
  prune: PrunePlan
  /**
   * When the plan was drawn, carried to the confirm step so a trip stored after this
   * run — one re-added in viaduct and re-imported between the two clicks — cannot be
   * deleted on the strength of a page that never showed it.
   */
  derivedAt: Date
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
 * A row's absolute departure, computed in Postgres from the wall clock and the origin's
 * IANA zone. One expression, used both by the upsert that writes `departure_at` and by
 * the query that resolves the file's identity keys, because the prune compares the two:
 * a second spelling here would be a second answer to "when did this leave".
 */
export function departureInstantSql(localTs: SQL | string, tz: SQL | string): SQL {
  // A string binds as a parameter (the upsert's per-row values); an SQL fragment
  // inlines (the VALUES columns in buildDepartureKeyQuery). Same expression either way.
  return sql`(${localTs}::timestamp AT TIME ZONE ${tz})`
}

/**
 * Resolve every parsed row to the identity the archive stores it under.
 *
 * It has to be a query. `departure_at` is an instant derived from a wall clock and a
 * named zone, and ADR 0048 is emphatic that the derivation lives in Postgres — a JS
 * copy would be a second implementation of DST. And it cannot be salvaged from the
 * upsert's `RETURNING`: the idempotency guard means an unchanged row is not returned
 * at all, which is precisely the re-import case the prune has to handle.
 *
 * Every parameter is cast inside its VALUES row rather than on the outer column
 * reference. Postgres resolves the VALUES rowtype before the outer select's casts, and
 * postgres-js sends strings with no type OID, so casting outside is the classic
 * "failed to determine data type of parameter $1".
 *
 * Rows come back tagged with their index rather than trusted to arrive in order.
 * Three parameters a row, so the 65535-parameter cap sits around 21,000 legs — two
 * orders of magnitude past the archive, which is why this is not chunked.
 */
export function buildDepartureKeyQuery(rows: readonly TripRow[]): SQL {
  const values = rows.map(
    (r, i) => sql`(${i}::int, ${r.departureLocal}::text, ${r.fromTz}::text)`,
  )
  const instant = departureInstantSql(sql`v.local`, sql`v.tz`)
  return sql`select v.i as i, ${departureKeySql(instant)} as key from (values ${sql.join(
    values,
    sql`, `,
  )}) as v(i, local, tz)`
}

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

const NO_PRUNE: PrunePlan = { window: null, inWindow: 0, candidates: [], refusal: null }

/**
 * Import parsed train trips, updating a matching trip in place rather than storing it
 * twice. Absolute instants are computed in Postgres from the local wall-clock + IANA
 * zone so DST and overnight legs resolve correctly. Re-importing the same export writes
 * nothing at all.
 *
 * It also reports what the export no longer contains — and removes none of it. Applying
 * a prune is `applyTripPrune`, which only the confirm step reaches, so a plain import
 * writes exactly what it wrote before that existed. See decision record 0054.
 */
export async function importTrainTrips(rows: TripRow[]): Promise<TripImportResult> {
  const total = rows.length
  const derivedAt = new Date()
  if (total === 0) {
    return { total: 0, inserted: 0, updated: 0, unchanged: 0, prune: NO_PRUNE, derivedAt }
  }

  // Resolve every row's departure instant before anything else. It is what the archive
  // keys on, so it is what an in-file duplicate has to be judged by, what the export's
  // coverage is measured in, and what the prune compares against.
  const fileIdentities = await resolveTripIdentities(rows)

  // Drop in-file duplicates so the single statement never reaches the same stored row
  // twice — Postgres rejects that outright ("ON CONFLICT DO UPDATE command cannot affect
  // row a second time"). Keyed on the identity itself rather than on the columns it is
  // derived from: two rows spelling one instant differently — 07:34 Europe/Oslo and
  // 05:34 UTC — survive a wall-clock key, then collide on the conflict target and kill
  // the whole statement.
  const seen = new Set<string>()
  const unique: TripRow[] = []
  const incomingIds: TripIdentity[] = []
  for (let i = 0; i < rows.length; i++) {
    const identity = fileIdentities[i]
    const key = identityKey(identity)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(rows[i])
    incomingIds.push(identity)
  }

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
    departureAt: departureInstantSql(r.departureLocal, r.fromTz),
    arrivalAt: r.arrivalLocal ? departureInstantSql(r.arrivalLocal, r.toTz) : null,
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

  // Planned after the upsert, so a leg this very file inserted is structurally incapable
  // of being a candidate — it is in `incomingIds`, and it is now in the window too.
  const prune = await planPrune(incomingIds)

  // Logged as well as returned. The page is one route away from being closed and
  // forgotten; this is the record that the file said these trips were gone, whether or
  // not the prune was ever confirmed.
  for (const c of prune.candidates) {
    logger.info(
      {
        id: c.id,
        from: c.fromStation,
        to: c.toStation,
        departureAt: c.departureAt,
        journey: c.journey,
        trainCode: c.trainCode,
        status: c.status,
        distanceKm: c.distanceKm,
      },
      'Trip is a prune candidate — this export does not contain it (nothing deleted)',
    )
  }
  if (prune.refusal) {
    logger.warn(
      { candidates: prune.candidates.length, inWindow: prune.inWindow },
      `Trip prune would be refused: ${prune.refusal}`,
    )
  }

  // Rows repeated within the file collapse into whichever copy was written, so they land
  // in `unchanged` alongside the trips that had nothing new to offer.
  return {
    total,
    inserted,
    updated,
    unchanged: total - inserted - updated,
    prune,
    derivedAt,
  }
}

/**
 * Resolve each parsed row to `(from_station, to_station, departure_at)` — the tuple the
 * archive stores it under — with the instant computed by Postgres and rendered as
 * canonical UTC text. Indexed rather than trusted to come back in order.
 */
async function resolveTripIdentities(rows: readonly TripRow[]): Promise<TripIdentity[]> {
  const resolved = (await getDb().execute(buildDepartureKeyQuery(rows))) as unknown as {
    i: number
    key: string
  }[]

  const keys = new Map(resolved.map((r) => [Number(r.i), String(r.key)]))
  return rows.map((r, i) => {
    const key = keys.get(i)
    // Postgres was handed one VALUES row per parsed row and returns one per row; a gap
    // would mean the two sides disagree about what was asked, which must not be papered
    // over with a guess at the instant.
    if (key === undefined) {
      throw new Error(`Postgres returned no departure instant for CSV row ${i + 1}`)
    }
    return { fromStation: r.fromStation, toStation: r.toStation, key }
  })
}

/**
 * What the export does not contain, inside the range it covers.
 *
 * The window is computed from the file alone and the stored read is bounded by it, so
 * a partial or truncated export cannot reach a single trip outside what it describes.
 */
async function planPrune(fileIds: readonly TripIdentity[]): Promise<PrunePlan> {
  const window = pruneWindow(fileIds)
  if (!window) return NO_PRUNE

  const storedInWindow = (await buildStoredInWindowSelect(
    window.from,
    window.to,
  )) as StoredTrip[]

  return planTripPrune(fileIds, storedInWindow, tripPruneLimits())
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
