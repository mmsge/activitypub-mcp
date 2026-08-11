import { getDb } from '../db/client.js'
import { gigCatalog, objects, serverConfig } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { isGigAttendance, parseGigAttendance } from '../lib/gig-attendance.js'
import { upsertGigAttendance } from './sync-gig-attendances.js'
import { enrichGig } from './sync-gig-metadata.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

// Bump when the backfill logic changes and existing installs need to run it again.
const MARKER_KEY = 'gig_backfill_v1'
const FETCH_DELAY_MS = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface GigBackfillResult {
  /** Stored objects that looked like an attendance and were re-parsed. */
  objectsScanned: number
  /**
   * Attendances upserted. Counts upserts attempted, not rows changed: a re-run replays
   * every stored attendance and the `updated_at_ap`-guarded upsert makes the unchanged
   * ones no-ops.
   */
  attendancesUpserted: number
  /** Distinct concerts enriched over the network, and how many failed. */
  gigsEnriched: number
  gigsFailed: number
  /** Concerts skipped because they already had a clean enrichment. */
  gigsSkipped: number
}

// A stored post that looks like a Gigowl attendance: its tags carry a Link named
// "Konsert" (or "Concert") pointing somewhere. Matched in SQL so the scan reads only the
// rows that can possibly qualify rather than every post in the archive.
const ATTENDANCE_SHAPED = sql`(
  jsonb_typeof(objects.tags) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(objects.tags) AS tag
    WHERE tag->>'type' = 'Link'
      AND lower(tag->>'name') IN ('konsert', 'concert')
      AND coalesce(tag->>'href', '') <> ''
  )
)`

/**
 * Rebuild the gig store from posts this server already holds, then enrich what they
 * reference.
 *
 * Local-first, like the NeoDB repair job: the attendances have been arriving and being
 * stored as ordinary posts since the follow was accepted, so the information is already
 * here — it was just never read. Re-crawling the origin's outbox would fetch data we hold
 * and would miss anything older than the 50 posts it serves. The only network traffic is
 * one request per concert we have no enriched record for (plus its venue and artists).
 *
 * Marker-guarded so it runs once per install on startup; `force` (the npm script and the
 * admin button) runs it again.
 */
export async function backfillGigs(opts: { force?: boolean } = {}): Promise<GigBackfillResult | null> {
  const db = getDb()
  const force = opts.force ?? false

  if (!force) {
    const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
    if (marker) return null
  }

  const rows = await db
    .select({ apId: objects.apId, actorApId: objects.actorApId, raw: objects.raw })
    .from(objects)
    .where(ATTENDANCE_SHAPED)

  let attendancesUpserted = 0
  const concertUrls = new Set<string>()

  for (const row of rows) {
    const raw = row.raw as AnyObject
    if (!isGigAttendance(raw)) continue
    // Attribute to the object's own author where it has one: an attendance that reached
    // us through a boost is still its author's, not the booster's (ADR 0011).
    const actorApId =
      (typeof raw.attributedTo === 'string' ? raw.attributedTo : null) ?? row.actorApId
    const attendance = parseGigAttendance(raw, actorApId)
    if (!attendance) continue
    try {
      await upsertGigAttendance(attendance)
      attendancesUpserted++
      concertUrls.add(attendance.concertUrl)
    } catch (e) {
      logger.warn({ apId: row.apId, error: e }, 'Gig backfill: attendance upsert failed')
    }
  }

  // Which of those concerts already have a clean enrichment, so a re-run does not refetch
  // the whole catalogue.
  const existing = await db
    .select({
      concertUrl: gigCatalog.concertUrl,
      enrichedAt: gigCatalog.enrichedAt,
      fetchError: gigCatalog.fetchError,
    })
    .from(gigCatalog)
  const enrichedOk = new Set(
    existing.filter((r) => r.enrichedAt && !r.fetchError).map((r) => r.concertUrl),
  )

  let gigsEnriched = 0
  let gigsFailed = 0
  let gigsSkipped = 0
  for (const concertUrl of concertUrls) {
    if (enrichedOk.has(concertUrl)) {
      gigsSkipped++
      continue
    }
    if (await enrichGig(concertUrl)) gigsEnriched++
    else gigsFailed++
    await sleep(FETCH_DELAY_MS)
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoUpdate({ target: serverConfig.key, set: { value: new Date().toISOString() } })

  const result: GigBackfillResult = {
    objectsScanned: rows.length,
    attendancesUpserted,
    gigsEnriched,
    gigsFailed,
    gigsSkipped,
  }
  logger.info({ ...result, concerts: concertUrls.size }, 'Gig backfill complete')
  return result
}
