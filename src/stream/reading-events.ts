import { and, or, like, not, type SQL } from 'drizzle-orm'
import { objects } from '../db/schema.js'
import type { ReadingEventType } from '../lib/bookwyrm-reading.js'
import type { Kind } from './sources.js'

/**
 * Which BookWyrm posts earn a place in the public stream.
 *
 * BookWyrm emits several posts per book — "started reading", automatic progress
 * notes, a bare star rating, a comment, a review — and putting all of them in the
 * timeline reads as machine noise rather than as reading. Markus' call: keep the
 * events that say something (started, finished, review, quotation), drop the ones
 * that are bookkeeping.
 *
 * Dropped, and why:
 *   rating   — a number with no words; the star already shows on the review card
 *   comment  — usually a progress note ("på side 120"), not a thought worth a row
 *   note     — BookWyrm's reading-goal announcements
 *   shelved  — "wants to read"; intent, not activity (same call as NeoDB wishlists)
 *
 * `isMeaningfulReadingEvent` and `meaningfulReadingCondition` must select the same
 * set. The SQL is what the query runs; the predicate is what the tests pin down.
 */
const MEANINGFUL: ReadingEventType[] = ['started_reading', 'finished_reading', 'review', 'quotation']

export function isMeaningfulReadingEvent(eventType: string): boolean {
  return (MEANINGFUL as string[]).includes(eventType)
}

/** The stream `kind` a reading event renders as. */
export function readingEventKind(eventType: string): Kind | null {
  switch (eventType) {
    case 'started_reading': return 'book_started'
    case 'finished_reading': return 'book_finished'
    case 'review': return 'book_review'
    case 'quotation': return 'book_quote'
    default: return null
  }
}

// BookWyrm encodes the kind of post in its ap_id path, because it federates
// everything as a plain Note. These mirror the segments in lib/bookwyrm-reading.ts.
const SEG_GENERATEDNOTE = '%/generatednote/%'
const SEG_REVIEW = '%/review/%'
const SEG_QUOTATION = '%/quotation/%'
const PHRASE_STARTED = '%started reading%'
const PHRASE_FINISHED = '%finished reading%'

/**
 * SQL mirror of `isMeaningfulReadingEvent`, pushed into the reading lane so the
 * database never hands us rows we are going to throw away.
 *
 * Deliberately built from positive matches rather than by excluding `/rating/`
 * and friends: a new BookWyrm post type would then arrive silently in the stream
 * rather than being ignored until someone decides it belongs.
 */
export function meaningfulReadingCondition(): SQL {
  return or(
    like(objects.apId, SEG_REVIEW),
    like(objects.apId, SEG_QUOTATION),
    and(
      like(objects.apId, SEG_GENERATEDNOTE),
      or(like(objects.contentText, PHRASE_STARTED), like(objects.contentText, PHRASE_FINISHED)),
    ),
  ) as SQL
}

/** Narrow the reading lane to a single stream kind, for /type/<kind>. */
export function readingKindCondition(kind: Kind): SQL | undefined {
  switch (kind) {
    case 'book_review':
      return like(objects.apId, SEG_REVIEW)
    case 'book_quote':
      return like(objects.apId, SEG_QUOTATION)
    case 'book_started':
      return and(like(objects.apId, SEG_GENERATEDNOTE), like(objects.contentText, PHRASE_STARTED))
    case 'book_finished':
      return and(
        like(objects.apId, SEG_GENERATEDNOTE),
        like(objects.contentText, PHRASE_FINISHED),
        // A generatednote can mention both verbs when a book is started and
        // finished in one go; classify it as the start so it is not double-counted.
        not(like(objects.contentText, PHRASE_STARTED)),
      )
    default:
      return undefined
  }
}
