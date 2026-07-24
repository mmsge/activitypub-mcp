import { getDb } from '../db/client.js'
import { neodbMarks, objects } from '../db/schema.js'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { isNeodbMark, parseNeodbMark, type ParsedNeodbMark } from '../lib/neodb-mark.js'
import { queueNeodbEnrichment } from './sync-neodb-metadata.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

/**
 * Upsert a parsed mark into neodb_marks, keyed on (item_url, actor_ap_id) — criterion 2.
 *
 * Idempotent (criterion 4): a re-received mark whose `updated` is strictly newer than the
 * stored one overwrites; an older-or-equal redelivery is a no-op, so the delete+recreate
 * bursts a backfill produces don't churn or fan out into duplicate rows. A qualifying
 * upsert also clears any prior tombstone — a recreate after a Delete brings the entry back.
 * Also enqueues metadata enrichment so the catalogue row that backs get_watched exists.
 */
export async function upsertNeodbMark(mark: ParsedNeodbMark): Promise<void> {
  const db = getDb()
  const now = new Date()
  if (mark.statusRaw && !mark.statusKnown) {
    logger.debug({ itemUrl: mark.itemUrl, status: mark.statusRaw }, 'Unknown NeoDB mark status verb — stored verbatim')
  }

  const values = {
    itemUrl: mark.itemUrl,
    actorApId: mark.actorApId,
    itemType: mark.itemType,
    category: mark.category,
    status: mark.status,
    statusRaw: mark.statusRaw,
    title: mark.title,
    coverUrl: mark.coverUrl,
    markApId: mark.markApId,
    markUrl: mark.markUrl,
    postId: mark.postId,
    publishedAt: mark.publishedAt,
    updatedAtAp: mark.updatedAtAp,
    deletedAt: null,
    raw: mark.raw as unknown as Record<string, unknown>,
    updatedAt: now,
  }

  await db
    .insert(neodbMarks)
    .values(values)
    .onConflictDoUpdate({
      target: [neodbMarks.itemUrl, neodbMarks.actorApId],
      set: values,
      // Overwrite only when this delivery is strictly newer (or an `updated` stamp is
      // missing on either side); an older/equal redelivery leaves the row — and its
      // tombstone, if any — untouched.
      setWhere: sql`${neodbMarks.updatedAtAp} is null
        or excluded.updated_at_ap is null
        or excluded.updated_at_ap > ${neodbMarks.updatedAtAp}`,
    })

  queueNeodbEnrichment(mark.itemUrl)
}

/**
 * Tombstone every live mark whose Note id matches — the Delete path (criterion 5). minreol
 * sends `Delete` → `Note` directly, so the Note id is the delete target. Soft-delete (not a
 * hard delete) so a later recreate can revive the same row and its history is auditable.
 * Returns how many rows were tombstoned.
 */
export async function tombstoneNeodbMark(markApId: string): Promise<number> {
  if (!markApId) return 0
  const db = getDb()
  const now = new Date()
  const res = await db
    .update(neodbMarks)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(neodbMarks.markApId, markApId), isNull(neodbMarks.deletedAt)))
    .returning({ id: neodbMarks.id })
  if (res.length) logger.debug({ markApId, tombstoned: res.length }, 'Tombstoned NeoDB mark(s) on Delete')
  return res.length
}

/**
 * Reprocess already-stored `objects` whose raw carries `relatedWith`, upserting each into
 * neodb_marks (criterion 7, the local no-network path). Idempotent — safe to re-run. Marks
 * whose stored raw lacks `relatedWith` (older rows) are not visible here; the outbox top-up
 * in backfill-neodb-marks covers those. Returns the count of marks upserted.
 */
export async function reprocessStoredMarks(): Promise<number> {
  const db = getDb()
  const BATCH = 500
  let lastId: string | null = null
  let upserted = 0

  for (;;) {
    const rows = await db
      .select({ id: objects.id, actorApId: objects.actorApId, raw: objects.raw })
      .from(objects)
      // `raw ? 'relatedWith'` prunes to mark candidates before we parse them.
      .where(
        and(
          sql`${objects.raw} ? 'relatedWith'`,
          lastId ? gt(objects.id, lastId) : undefined,
        ),
      )
      .orderBy(asc(objects.id))
      .limit(BATCH)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      const raw = row.raw as AnyObject
      if (!isNeodbMark(raw)) continue
      // Prefer the object's attributedTo; fall back to the stored actor.
      const actorApId = (typeof raw.attributedTo === 'string' ? raw.attributedTo : null) ?? row.actorApId
      const mark = parseNeodbMark(raw, actorApId)
      if (!mark) continue
      try {
        await upsertNeodbMark(mark)
        upserted++
      } catch (e) {
        logger.warn({ itemUrl: mark.itemUrl, error: e }, 'Failed to upsert reprocessed NeoDB mark')
      }
    }
  }

  return upserted
}
