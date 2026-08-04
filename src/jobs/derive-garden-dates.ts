import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { publicOnlyOn } from '../stream/visibility.js'
import { ownGardenDateOn } from '../stream/garden-date-sql.js'

/**
 * Give the undated garden notes a date, from the reading events they are about.
 *
 * markus.plus has no date for most of its notes. 102 of the 384 published notes
 * carry a `dato`/`modified`/`anskaffet` frontmatter field; the other 282 carry
 * nothing — the Obsidian Publish cache document has no mtime either, so there is
 * no date to read anywhere. Ordering the stream by event date left three quarters
 * of the garden out of meg.msge.no.
 *
 * But 158 of those 282 are book reviews, and a book review carries `bookwyrm`: the
 * Edition URL of the book. The archive already holds Markus' own BookWyrm reading
 * events for those editions, with his own dates on them. So the note's date is
 * *recoverable* rather than invented — it is when he finished and reviewed the
 * book he then wrote about.
 *
 * Three rules make that defensible:
 *
 *  - It is stored in `derived_date`, never in `note_date`. The note's own claim and
 *    our inference stay separable, and the page says which one it is showing.
 *  - Only public reading events count. A followers-only review's date would
 *    otherwise become a public fact about when Markus read something — the same
 *    fail-closed rule the rest of the stream runs on (ADR 0017).
 *  - A review beats a finish, and the reader's own date beats the post date. The
 *    markus.plus review is the counterpart of the BookWyrm review, so that is the
 *    closest event; the finish is the fallback.
 *
 * The remaining 124 notes stay undated and out of the stream. They are listed,
 * dateless, at the foot of /kjelde/hage instead — see loadUndatedGardenNotes.
 */

/** BookWyrm encodes the post type in its ap_id path; these mirror reading-events.ts. */
const SEG_REVIEW = '%/review/%'
const SEG_GENERATEDNOTE = '%/generatednote/%'
const PHRASE_FINISHED = '%finished reading%'

export interface DeriveGardenDatesResult {
  /** Notes whose derived_date was written or changed. */
  updated: number
  /** Notes that now have a stream date only because of this derivation. */
  recovered: number
  /** Notes still undated: no frontmatter date and no usable reading event. */
  stillUndated: number
}

export async function deriveGardenDates(): Promise<DeriveGardenDatesResult> {
  const db = getDb()

  // One statement: for every edition, the best-dated public reading event, joined
  // onto the notes that name it. DISTINCT ON picks the winner per book_url under
  // the ORDER BY — rank first (review beats finish), then newest.
  const updated = await db.execute(sql`
    WITH candidate AS (
      SELECT
        bo.book_url,
        CASE WHEN o.ap_id LIKE ${SEG_REVIEW} THEN 1 ELSE 2 END AS rank,
        coalesce(bo.finish_date::timestamptz, o.published_at) AS at
      FROM bookwyrm_objects bo
      JOIN objects o ON o.ap_id = bo.object_ap_id
      WHERE bo.book_url IS NOT NULL
        AND o.deleted_at IS NULL
        AND o.published_at IS NOT NULL
        AND (o.ap_id LIKE ${SEG_REVIEW}
             OR (o.ap_id LIKE ${SEG_GENERATEDNOTE} AND o.content_text LIKE ${PHRASE_FINISHED}))
        AND ${publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED)}
    ),
    best AS (
      SELECT DISTINCT ON (book_url) book_url, at
      FROM candidate
      WHERE at IS NOT NULL AND at <= now()
      ORDER BY book_url, rank, at DESC
    )
    UPDATE garden_notes g
    SET derived_date = best.at, updated_at = now()
    FROM best
    WHERE g.book_url = best.book_url
      AND g.deleted_at IS NULL
      AND g.derived_date IS DISTINCT FROM best.at
    RETURNING g.id`)

  // Counted with the lane's own definition of "has a date", not a second copy of
  // it: a note whose note_date reads "ein gong i fjor" has a date field and no
  // date, and must be counted undated here exactly as the lane treats it.
  const own = ownGardenDateOn('g')
  const [counts] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${own} IS NULL AND g.derived_date IS NOT NULL)::int AS recovered,
      count(*) FILTER (WHERE ${own} IS NULL AND g.derived_date IS NULL)::int AS still_undated
    FROM garden_notes g
    WHERE g.deleted_at IS NULL
      -- The home page is a row in this table but never a stream entry. Counting it
      -- would make still_undated one more than the page actually lists.
      AND g.path <> '/'`)) as unknown as Array<{ recovered: number; still_undated: number }>

  const result: DeriveGardenDatesResult = {
    updated: (updated as unknown as unknown[]).length,
    recovered: counts?.recovered ?? 0,
    stillUndated: counts?.still_undated ?? 0,
  }
  logger.info(result, 'Garden note dates derived from reading events')
  return result
}
