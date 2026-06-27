import { sql, and, or, like, type SQL } from 'drizzle-orm'
import { objects } from '../db/schema.js'

// BookWyrm federates reading activity as plain `type: "Note"` objects, so the
// reading semantics live in the `ap_id` URL path segment plus the post content,
// not in the AP `type` field. This module classifies those Notes into normalized
// reading events on the fly from the generic `objects` post store, so the reading
// tools stay consistent with `get_actor_posts` by construction (single source of
// truth — no separately-populated table to backfill).

export type ReadingEventType =
  | 'started_reading'
  | 'finished_reading'
  | 'review'
  | 'rating'
  | 'comment'
  | 'note'
  | 'shelved'

// ap_id path segments emitted by BookWyrm for federated Notes.
const SEG_GENERATEDNOTE = '%/generatednote/%'
const SEG_COMMENT = '%/comment/%'
const SEG_REVIEW = '%/review/%'
const SEG_RATING = '%/rating/%'

// Content phrases BookWyrm puts in generatednote posts ("Markus 🌱 started
// reading X"). Kept here so the SQL filters and the JS classifier below can
// never drift. NOTE: BookWyrm emits these lowercased mid-sentence, so a plain
// case-sensitive `LIKE` matches; if casing ever varies, switch the LIKEs to
// `ilike` AND keep the JS `toLowerCase` checks in sync.
const PHRASE_STARTED = 'started reading'
const PHRASE_FINISHED = 'finished reading'
const PHRASE_WANTS = 'wants to read'

export interface ClassifierInput {
  apId: string
  content: string | null // objects.contentText (HTML already stripped at ingest)
  tags: unknown // objects.tags jsonb
  attachments: unknown // objects.attachments jsonb
}

export interface ReadingEvent {
  event_type: ReadingEventType
  book_title: string | null
  book_author: string | null
  bookwyrm_book_url: string | null
  comment: string | null
}

/**
 * Classify a single `objects` row into a normalized reading event, or `null` if
 * the row isn't a classifiable BookWyrm reading event. Mirrors the SQL helpers
 * below exactly; the SELECT base condition guarantees a non-null result.
 */
export function classifyReadingEvent(row: ClassifierInput): ReadingEvent | null {
  const ap = row.apId.toLowerCase()
  const content = row.content ?? ''
  const lc = content.toLowerCase()

  let event_type: ReadingEventType
  if (ap.includes('/generatednote/')) {
    if (lc.includes(PHRASE_STARTED)) event_type = 'started_reading'
    else if (lc.includes(PHRASE_FINISHED)) event_type = 'finished_reading'
    else if (lc.includes(PHRASE_WANTS)) event_type = 'shelved'
    else event_type = 'note' // reading goals, "stopped reading", etc. — not dropped
  } else if (ap.includes('/comment/')) {
    event_type = 'comment'
  } else if (ap.includes('/review/')) {
    event_type = 'review'
  } else if (ap.includes('/rating/')) {
    event_type = 'rating'
  } else {
    return null // caller drops it
  }

  const { title, author, url } = extractBookMeta(row, content)
  return {
    event_type,
    book_title: title,
    book_author: author,
    bookwyrm_book_url: url,
    comment: event_type === 'comment' || event_type === 'review' ? content || null : null,
  }
}

// Book metadata extraction precedence: Edition tag -> attachment name -> content.
function extractBookMeta(
  row: ClassifierInput,
  content: string,
): { title: string | null; author: string | null; url: string | null } {
  let title: string | null = null
  let author: string | null = null
  let url: string | null = null

  // 1) Edition tag — most reliable: { type: "Edition", name: "@Title", href: <book url> }
  const editionTag = asArray(row.tags).find(
    (t) => isObj(t) && t.type === 'Edition',
  )
  if (isObj(editionTag)) {
    if (typeof editionTag.name === 'string') title = editionTag.name.replace(/^@/, '').trim()
    if (typeof editionTag.href === 'string') url = editionTag.href
  }

  // 2) Attachment name "Author: Title (Format, lang, year, publisher)".
  const att = asArray(row.attachments).find(
    (a) => isObj(a) && typeof a.name === 'string',
  )
  if (isObj(att) && typeof att.name === 'string') {
    const name = att.name
    const idx = name.indexOf(': ')
    if (idx > 0) {
      const a = name.slice(0, idx).trim()
      let rest = name.slice(idx + 2).trim()
      const paren = rest.indexOf(' (')
      if (paren > 0) rest = rest.slice(0, paren).trim()
      if (!author) author = a || null
      if (!title) title = rest || null
    } else if (!title) {
      title = name.trim() || null
    }
  }

  // 3) Content regex fallback (title only).
  if (!title) {
    const m =
      /started reading (.+?)(?:[.\n]|$)/i.exec(content) ??
      /finished reading (.+?)(?:[.\n]|$)/i.exec(content) ??
      /wants to read (.+?)(?:[.\n]|$)/i.exec(content) ??
      /\(comment on (.+?)\)\s*$/i.exec(content)
    if (m?.[1]) title = m[1].trim()
  }

  return { title, author, url }
}

/**
 * Base predicate: only `objects` rows whose ap_id matches a known BookWyrm
 * segment. Keeps unrelated Notes out so `classifyReadingEvent` never returns
 * null for a selected row.
 */
export function readingEventBaseCondition(): SQL {
  return or(
    like(objects.apId, SEG_GENERATEDNOTE),
    like(objects.apId, SEG_COMMENT),
    like(objects.apId, SEG_REVIEW),
    like(objects.apId, SEG_RATING),
  )!
}

/**
 * Per-event_type filter — the inverse of `classifyReadingEvent`, expressed in
 * SQL so `event_type` is filtered in the query (keeping `limit` exact and the
 * keyset cursor correct) rather than over-fetching and filtering in memory.
 */
export function readingEventTypeCondition(et: ReadingEventType): SQL | undefined {
  switch (et) {
    case 'started_reading':
      return and(like(objects.apId, SEG_GENERATEDNOTE), like(objects.contentText, `%${PHRASE_STARTED}%`))
    case 'finished_reading':
      return and(like(objects.apId, SEG_GENERATEDNOTE), like(objects.contentText, `%${PHRASE_FINISHED}%`))
    case 'shelved':
      return and(like(objects.apId, SEG_GENERATEDNOTE), like(objects.contentText, `%${PHRASE_WANTS}%`))
    case 'note':
      // generatednote that is none of started/finished/wants-to-read (goals etc.).
      // NULL content is a `note` to match the JS `content ?? ''` branch.
      return and(
        like(objects.apId, SEG_GENERATEDNOTE),
        sql`(${objects.contentText} IS NULL OR (
          ${objects.contentText} NOT LIKE ${`%${PHRASE_STARTED}%`} AND
          ${objects.contentText} NOT LIKE ${`%${PHRASE_FINISHED}%`} AND
          ${objects.contentText} NOT LIKE ${`%${PHRASE_WANTS}%`}))`,
      )
    case 'comment':
      return like(objects.apId, SEG_COMMENT)
    case 'review':
      return like(objects.apId, SEG_REVIEW)
    case 'rating':
      return like(objects.apId, SEG_RATING)
  }
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
