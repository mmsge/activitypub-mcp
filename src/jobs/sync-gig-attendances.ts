import { getDb } from '../db/client.js'
import { gigAttendances } from '../db/schema.js'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { ParsedGigAttendance } from '../lib/gig-attendance.js'
import { queueGigEnrichment } from './sync-gig-metadata.js'
import { logger } from '../lib/logger.js'

/**
 * Upsert a parsed attendance into gig_attendances, keyed on (concert_url, actor_ap_id).
 *
 * Idempotent on `updated_at_ap`, exactly as the NeoDB mark store is (ADR 0008): a
 * re-received attendance whose stamp is strictly newer overwrites, an older-or-equal
 * redelivery is a no-op. That matters here because an attendance is edited in place —
 * adding a write-up or photos to a gig logged months ago re-publishes the same Note id —
 * and because a backfill replays every stored object at once.
 *
 * Two null-fill exceptions ride alongside the guard, both monotone (they only ever
 * populate something absent, never revert a good value):
 *
 *   - a row whose `status` is null takes one that is offered. The attendances delivered
 *     before Gigowl's ADR 0026 carry their state only in the generated prose, so a
 *     redelivery that finally carries the explicit tag must be able to fill it in even
 *     when the stamps tie.
 *   - a row whose `review` is null takes one that is offered, for the same reason: a
 *     write-up added later is the single most valuable thing an attendance gains.
 *
 * A qualifying upsert also clears any tombstone, so a deleted-then-recreated attendance
 * comes back rather than staying invisible.
 */
export async function upsertGigAttendance(attendance: ParsedGigAttendance): Promise<void> {
  const db = getDb()
  const now = new Date()

  if (attendance.statusRaw && !attendance.statusKnown) {
    logger.debug(
      { concertUrl: attendance.concertUrl, status: attendance.statusRaw },
      'Unknown Gigowl attendance state — stored verbatim',
    )
  }

  const values = {
    concertUrl: attendance.concertUrl,
    actorApId: attendance.actorApId,
    status: attendance.status,
    statusRaw: attendance.statusRaw,
    statusSource: attendance.statusSource,
    review: attendance.review,
    contentWarning: attendance.contentWarning,
    hashtags: attendance.hashtags,
    photos: attendance.photos,
    noteApId: attendance.noteApId,
    noteUrl: attendance.noteUrl,
    postId: attendance.postId,
    publishedAt: attendance.publishedAt,
    updatedAtAp: attendance.updatedAtAp,
    deletedAt: null,
    raw: attendance.raw as unknown as Record<string, unknown>,
    updatedAt: now,
  }

  await db
    .insert(gigAttendances)
    .values(values)
    .onConflictDoUpdate({
      target: [gigAttendances.concertUrl, gigAttendances.actorApId],
      set: values,
      setWhere: sql`${gigAttendances.updatedAtAp} is null
        or excluded.updated_at_ap is null
        or excluded.updated_at_ap > ${gigAttendances.updatedAtAp}
        or (${gigAttendances.status} is null and excluded.status is not null)
        or (${gigAttendances.review} is null and excluded.review is not null)`,
    })

  queueGigEnrichment(attendance.concertUrl)
}

/**
 * Tombstone every live attendance whose Note id matches — the Delete path.
 *
 * Soft, like the NeoDB mark tombstone: the history stays auditable and a recreate can
 * revive the same row. Returns how many rows were tombstoned.
 */
export async function tombstoneGigAttendance(noteApId: string): Promise<number> {
  if (!noteApId) return 0
  const now = new Date()
  const rows = await getDb()
    .update(gigAttendances)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(gigAttendances.noteApId, noteApId), isNull(gigAttendances.deletedAt)))
    .returning({ id: gigAttendances.id })
  if (rows.length > 0) {
    logger.info({ noteApId, count: rows.length }, 'Tombstoned Gigowl attendance')
  }
  return rows.length
}
