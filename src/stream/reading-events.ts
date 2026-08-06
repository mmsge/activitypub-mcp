import { sql, type SQL } from 'drizzle-orm'
import { normalizeReadingStatus } from '../lib/bookwyrm-reading.js'
import type { Kind } from './sources.js'

/**
 * Which BookWyrm posts earn a place in the public stream, and which card each one
 * renders as.
 *
 * BookWyrm federates every reading event as a plain Note and encodes the kind in
 * the ap_id path segment, so classifying one is a matter of `LIKE` on the id plus a
 * look at the shelf state the post carries. `streamReadingKind` is the readable
 * statement of the rule and `readingKindCaseOn` is the same rule in SQL; the SQL is
 * what the query runs, the predicate is what the tests pin down, and they are
 * checked against each other case by case.
 *
 * Everything except "wants to read" is published. That is a change — the lane used
 * to keep only the four events that arrive as their own post (started, finished,
 * review, quotation) and drop comments, ratings and reading-goal notes as
 * bookkeeping. The trap that broke is this: **BookWyrm emits no GeneratedNote at
 * all when a shelf is flipped with text written in the same modal.** It posts one
 * Comment, and the reading status is inside it. So dropping comments did not drop
 * progress notes, it dropped real starts and finishes — every reading event Markus
 * had written a sentence about vanished from his own timeline, which is a strange
 * thing for a stream to do with the posts that took the most effort.
 *
 * `shelved` stays out, in whichever shape it arrives: a GeneratedNote saying "wants
 * to read", or a Comment carrying the `to-read` shelf. Intent is not activity — the
 * same call as NeoDB wishlists and planned journeys.
 */

// ap_id path segments emitted by BookWyrm. These mirror lib/bookwyrm-reading.ts.
const SEG_GENERATEDNOTE = '%/generatednote/%'
const SEG_COMMENT = '%/comment/%'
const SEG_REVIEW = '%/review/%'
// Not `/rating/`: a bare star federates as `/reviewrating/`, which `%/rating/%`
// cannot match — the character before "rating" is a "w". See the same constant in
// lib/bookwyrm-reading.ts, where the typo made `event_type: 'rating'` unfillable.
const SEG_RATING = '%/reviewrating/%'
const SEG_QUOTATION = '%/quotation/%'
const PHRASE_STARTED = '%started reading%'
const PHRASE_FINISHED = '%finished reading%'
const PHRASE_WANTS = '%wants to read%'

/** What the classifier needs off an `objects` row. */
export interface StreamReadingRow {
  apId: string
  contentText: string | null
  /** The reader's shelf at post time, from `objects.raw->>'readingStatus'`. */
  readingStatus?: string | null
}

/**
 * The card a BookWyrm post renders as, or null when it has no place in the stream.
 *
 * The JS twin of `readingKindCaseOn` below. Written first because the ordering is
 * the whole design and it is unreadable in a SQL CASE: a review or a rating is a
 * verdict and keeps its own card even when the same post also closes the book, and
 * only once those are out of the way does the shelf state decide.
 */
export function streamReadingKind(row: StreamReadingRow): Kind | null {
  const ap = row.apId.toLowerCase()
  const text = (row.contentText ?? '').toLowerCase()
  const status = normalizeReadingStatus(row.readingStatus ?? null)

  if (ap.includes('/review/') || ap.includes('/reviewrating/')) return 'book_review'
  if (ap.includes('/quotation/')) return 'book_quote'

  const generated = ap.includes('/generatednote/')
  const comment = ap.includes('/comment/')
  // An ap_id shape nobody has taught this module about. Selecting positively rather
  // than excluding known-bad segments means a new BookWyrm post type waits to be
  // understood instead of arriving on the page unannounced.
  if (!generated && !comment) return null

  if (generated && text.includes('wants to read')) return null
  if (comment && status === 'to-read') return null

  if (isFinish(generated, comment, text, status)) return 'book_finished'
  if (isStart(generated, comment, text, status)) return 'book_started'
  return 'book_comment'
}

/**
 * This post says the book was finished.
 *
 * Two shapes, because BookWyrm has two: a bare shelf flip names the verb in the
 * GeneratedNote's text, a shelf flip with a sentence attached says so only in the
 * Comment's `readingStatus`.
 *
 * The `NOT started reading` guard is load-bearing. One GeneratedNote can name both
 * verbs when a book is opened and closed the same day, and it has always rendered
 * as the start; without the guard the finish test matches it first and every such
 * card silently flips.
 */
function isFinish(generated: boolean, comment: boolean, text: string, status: string | null): boolean {
  if (generated) return text.includes('finished reading') && !text.includes('started reading')
  return comment && status === 'read'
}

function isStart(generated: boolean, comment: boolean, text: string, status: string | null): boolean {
  if (generated) return text.includes('started reading')
  return comment && status === 'reading'
}

/**
 * The same selections written against a table alias, for the hand-written lane SQL.
 *
 * A drizzle-built condition emits `"objects"."ap_id"`, which does not resolve inside
 * `FROM objects o`. See the note on publicOnlyOn.
 */
function assertAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Unusable SQL alias: ${alias}`)
}

function colsOf(alias: string): { ap: SQL; txt: SQL } {
  assertAlias(alias)
  return { ap: sql.raw(`${alias}.ap_id`), txt: sql.raw(`${alias}.content_text`) }
}

/**
 * `readingStatus` narrowed to one shelf, in SQL.
 *
 * BookWyrm sends either the bare word or the shelf's own URL (`…/books/to-read`),
 * and the words nest — "to-read" contains "read", "reading" contains "read" — so the
 * tests are ordered and each excludes the ones above it. Mirrors
 * `normalizeReadingStatus`; the tests pin the two against the same inputs.
 */
export function readingStatusOn(alias: string, want: 'read' | 'reading' | 'to-read'): SQL {
  assertAlias(alias)
  const s = sql.raw(`lower(coalesce(${alias}.raw->>'readingStatus', ''))`)
  const toRead = sql`(${s} LIKE '%to-read%' OR ${s} LIKE '%want-to-read%')`
  if (want === 'to-read') return toRead
  const reading = sql`(NOT ${toRead} AND ${s} LIKE '%reading%')`
  if (want === 'reading') return reading
  return sql`(NOT ${toRead} AND NOT ${reading} AND ${s} LIKE '%read%')`
}

/** See isFinish — this is the same rule, in SQL. */
export function finishSignalOn(alias: string): SQL {
  const { ap, txt } = colsOf(alias)
  return sql`((${ap} LIKE ${SEG_GENERATEDNOTE} AND ${txt} LIKE ${PHRASE_FINISHED}
                AND ${txt} NOT LIKE ${PHRASE_STARTED})
    OR (${ap} LIKE ${SEG_COMMENT} AND ${readingStatusOn(alias, 'read')}))`
}

/** See isStart — this is the same rule, in SQL. */
export function startSignalOn(alias: string): SQL {
  const { ap, txt } = colsOf(alias)
  return sql`((${ap} LIKE ${SEG_GENERATEDNOTE} AND ${txt} LIKE ${PHRASE_STARTED})
    OR (${ap} LIKE ${SEG_COMMENT} AND ${readingStatusOn(alias, 'reading')}))`
}

/** A review, a rating or a quotation — the posts that keep their card regardless. */
function verdictOn(alias: string): SQL {
  const { ap } = colsOf(alias)
  return sql`(${ap} LIKE ${SEG_REVIEW} OR ${ap} LIKE ${SEG_RATING} OR ${ap} LIKE ${SEG_QUOTATION})`
}

/**
 * SQL mirror of `streamReadingKind`'s null branch, pushed into the reading lane so
 * the database never hands us rows we are going to throw away.
 *
 * A NULL `content_text` reads as a plain note, matching the JS `?? ''`.
 */
export function meaningfulReadingOn(alias: string): SQL {
  const { ap, txt } = colsOf(alias)
  return sql`(${ap} LIKE ${SEG_REVIEW} OR ${ap} LIKE ${SEG_RATING} OR ${ap} LIKE ${SEG_QUOTATION}
    OR (${ap} LIKE ${SEG_COMMENT} AND NOT ${readingStatusOn(alias, 'to-read')})
    OR (${ap} LIKE ${SEG_GENERATEDNOTE}
        AND (${txt} IS NULL OR ${txt} NOT LIKE ${PHRASE_WANTS})))`
}

/** SQL mirror of `streamReadingKind`. The lane's `kind` column. */
export function readingKindCaseOn(alias: string): SQL {
  const { ap } = colsOf(alias)
  return sql`CASE
    WHEN ${ap} LIKE ${SEG_REVIEW} OR ${ap} LIKE ${SEG_RATING} THEN 'book_review'
    WHEN ${ap} LIKE ${SEG_QUOTATION} THEN 'book_quote'
    WHEN ${finishSignalOn(alias)} THEN 'book_finished'
    WHEN ${startSignalOn(alias)} THEN 'book_started'
    ELSE 'book_comment' END`
}

/**
 * The Edition this post is about, whichever way BookWyrm attached it.
 *
 * Comments, reviews and quotations carry `inReplyToBook`; a GeneratedNote carries an
 * `Edition` tag instead. Mirrors `bookUrlFor` in query.ts, which does the same thing
 * in JS at hydration time.
 */
export function bookUrlOn(alias: string): SQL {
  assertAlias(alias)
  const raw = sql.raw(`${alias}.raw`)
  const tags = sql.raw(`${alias}.tags`)
  // The array guard belongs in the FROM, not the WHERE. `objects.tags` is nullable
  // and is occasionally an object, and jsonb_array_elements raises on both — a WHERE
  // clause never runs, because the set-returning function has already failed.
  return sql`coalesce(${raw}->>'inReplyToBook', (
    SELECT t->>'href'
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${tags}) = 'array' THEN ${tags} ELSE '[]'::jsonb END) AS t
    WHERE t->>'type' = 'Edition' AND t->>'href' IS NOT NULL
    LIMIT 1))`
}

/**
 * A bare GeneratedNote that a Comment on the same day already says better.
 *
 * Flipping a shelf *and* writing a sentence usually produces only the Comment, but
 * not always — BookWyrm will emit both, and then one act of reading is two cards.
 * Collapse them onto the one that carries the words.
 *
 * Two things about this are deliberate:
 *
 *  - The day compared is the *stream's* `event_at`, not `published_at`. A
 *    GeneratedNote is placed by the reader's own `startedDate`, so that is the day it
 *    appears on, and "no two cards for one book on one day" is a claim about the
 *    page. Where the two land on different days they are two days, and both stay.
 *  - The Comment must pass the same visibility gate as the row it suppresses. A
 *    followers-only comment is not permitted to delete a public note from the page.
 *  - The inner side reads `inReplyToBook` straight, rather than through bookUrlOn:
 *    a comment never carries an Edition tag, so walking its jsonb would cost a
 *    subplan per candidate row and find nothing. A comment missing the field fails
 *    the equality and both cards stay, which is the safe direction to fail in.
 *
 * Written as a NOT EXISTS inside the lane rather than as a pass over the results:
 * every lane carries its own keyset predicate and LIMIT, so dropping rows afterwards
 * would return short pages and lose entries across page boundaries.
 */
export function supersededGeneratedNoteOn(alias: string, eventAt: SQL, visibility: SQL): SQL {
  const { ap } = colsOf(alias)
  return sql`(${ap} LIKE ${SEG_GENERATEDNOTE} AND ${bookUrlOn(alias)} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM objects c
       WHERE c.actor_ap_id = ${sql.raw(`${alias}.actor_ap_id`)}
         AND c.deleted_at IS NULL
         AND c.ap_id LIKE ${SEG_COMMENT}
         AND ${visibility}
         AND c.published_at IS NOT NULL
         AND (c.raw->>'inReplyToBook') = ${bookUrlOn(alias)}
         AND date_trunc('day', c.published_at AT TIME ZONE 'Europe/Oslo')
           = date_trunc('day', ${eventAt} AT TIME ZONE 'Europe/Oslo')
         AND ((${startSignalOn(alias)} AND ${readingStatusOn('c', 'reading')})
           OR (${finishSignalOn(alias)} AND ${readingStatusOn('c', 'read')}))))`
}

/**
 * Narrow the reading lane to a single stream kind, for /type/<kind>.
 *
 * Written as the CASE's arms unrolled rather than as `readingKindCaseOn(alias) =
 * kind`, because a lane predicate has to be something an index can be used for.
 * The `NOT` chain is what makes the arms exclusive, exactly as falling through a
 * CASE does.
 */
export function readingKindOn(alias: string, kind: Kind): SQL | undefined {
  const { ap } = colsOf(alias)
  switch (kind) {
    case 'book_review':
      return sql`(${ap} LIKE ${SEG_REVIEW} OR ${ap} LIKE ${SEG_RATING})`
    case 'book_quote':
      return sql`${ap} LIKE ${SEG_QUOTATION}`
    case 'book_finished':
      return sql`(NOT ${verdictOn(alias)} AND ${finishSignalOn(alias)})`
    case 'book_started':
      return sql`(NOT ${verdictOn(alias)} AND NOT ${finishSignalOn(alias)}
                  AND ${startSignalOn(alias)})`
    case 'book_comment':
      return sql`(NOT ${verdictOn(alias)} AND NOT ${finishSignalOn(alias)}
                  AND NOT ${startSignalOn(alias)})`
    default:
      return undefined
  }
}
