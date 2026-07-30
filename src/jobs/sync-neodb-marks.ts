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
 *
 * The shelf date (`watched_at`) rides that same guard, which is what the backfill procedure
 * needs: minreol does not federate a backdated mark on creation, so the real date arrives
 * moments later in an `Update` carrying the same Note id and a strictly newer `updated`
 * stamp — a qualifying overwrite. One extra clause covers the degenerate case where the
 * stamps tie: a row still missing a date takes one that is offered. That arm is monotone
 * (it only ever fills a null), so it can never revert a good date to an older delivery's.
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
    comment: mark.comment,
    markApId: mark.markApId,
    markUrl: mark.markUrl,
    postId: mark.postId,
    publishedAt: mark.publishedAt,
    updatedAtAp: mark.updatedAtAp,
    watchedAt: mark.watchedAt,
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
      // tombstone, if any — untouched. The last arm is the null-fill exception described
      // above: a stored row with no shelf date accepts one even from an equal-stamped
      // redelivery, so a date can never be stranded by a tie.
      setWhere: sql`${neodbMarks.updatedAtAp} is null
        or excluded.updated_at_ap is null
        or excluded.updated_at_ap > ${neodbMarks.updatedAtAp}
        or (${neodbMarks.watchedAt} is null and excluded.watched_at is not null)`,
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
 * Fill in `comment` for mark rows that predate the column, reading it back out of the
 * stored mark `Note`s (criterion: the comment must be queryable for marks already
 * ingested, not just new ones).
 *
 * This cannot go through `upsertNeodbMark`: that upsert only overwrites when the incoming
 * `updated` stamp is strictly newer, so replaying an unchanged mark is deliberately a
 * no-op and would leave `comment` null forever. Instead it writes the column directly and
 * only where it is still empty — never overwriting a comment already stored. Where several
 * stored marks map to the same (item, actor), the most recently published one wins.
 *
 * Returns how many rows were filled.
 */
export async function backfillMarkComments(): Promise<number> {
  const db = getDb()
  // Ascending by publish date so a later mark's comment overwrites an earlier one in the
  // map — the newest comment is the one that lands.
  const rows = await db
    .select({ actorApId: objects.actorApId, raw: objects.raw })
    .from(objects)
    .where(sql`${objects.raw} ? 'relatedWith'`)
    .orderBy(asc(objects.publishedAt))

  const byKey = new Map<string, { itemUrl: string; actorApId: string; comment: string }>()
  for (const row of rows) {
    const raw = row.raw as AnyObject
    if (!isNeodbMark(raw)) continue
    const actorApId = (typeof raw.attributedTo === 'string' ? raw.attributedTo : null) ?? row.actorApId
    const mark = parseNeodbMark(raw, actorApId)
    if (!mark?.comment) continue
    byKey.set(`${mark.itemUrl} ${mark.actorApId}`, {
      itemUrl: mark.itemUrl,
      actorApId: mark.actorApId,
      comment: mark.comment,
    })
  }

  let filled = 0
  for (const { itemUrl, actorApId, comment } of byKey.values()) {
    const res = await db
      .update(neodbMarks)
      .set({ comment })
      .where(and(
        eq(neodbMarks.itemUrl, itemUrl),
        eq(neodbMarks.actorApId, actorApId),
        isNull(neodbMarks.comment),
      ))
      .returning({ id: neodbMarks.id })
    filled += res.length
  }
  if (filled) logger.info({ filled }, 'Backfilled NeoDB mark comments from stored marks')
  return filled
}

/**
 * Fill in `watched_at` for mark rows that predate the column, reading the shelf date back
 * out of each row's own stored `raw` (criterion 2).
 *
 * Same reason as `backfillMarkComments` this cannot go through `upsertNeodbMark`: that
 * upsert deliberately no-ops on an unchanged `updated` stamp, so replaying stored marks —
 * the obvious way to populate a new column — would leave every one of them null.
 *
 * The source is `neodb_marks.raw->'relatedWith'`, which is the `Status` entry exactly as
 * parsed (that shape has been stable since the store was introduced; the pre-comment
 * version stored `{relatedWith, tag}`, the current one `{relatedWith, comment, tag}`, and
 * `relatedWith` is the Status object in both). Reading the row's own provenance rather
 * than re-walking `objects` also covers marks whose Note is no longer stored.
 *
 * Only rows where `watched_at` is still null are touched — a date already stored, whether
 * from ingest or a prior run, is never overwritten. Returns how many rows were filled.
 */
export const WATCHED_AT_BACKFILL = sql`
  UPDATE neodb_marks
  SET watched_at = (raw->'relatedWith'->>'published')::timestamptz,
      updated_at = now()
  WHERE watched_at IS NULL
    AND jsonb_typeof(raw->'relatedWith') = 'object'
    AND raw->'relatedWith'->>'type' = 'Status'
    -- Shape guard, not validation: an unparseable string would abort the whole
    -- statement on the cast, and one malformed mark must not block the backfill.
    -- Spelled as an explicit character class rather than a backslash-d shorthand,
    -- because this is a JS template literal: it eats the backslash, so the shorthand
    -- ships as a run of literal letters — a regex that matches nothing and makes the
    -- backfill silently fill zero rows. A test asserts the rendered SQL, since
    -- nothing else fails when it is wrong.
    AND raw->'relatedWith'->>'published' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
  RETURNING id
`

export async function backfillMarkWatchedDates(): Promise<number> {
  const db = getDb()
  const res = await db.execute<{ id: string }>(WATCHED_AT_BACKFILL)
  const filled = [...res].length
  if (filled) logger.info({ filled }, 'Backfilled NeoDB mark watch dates from stored raw')
  return filled
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
