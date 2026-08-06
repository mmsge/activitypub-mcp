import { sql, and, or, like, type SQL } from 'drizzle-orm'
import { objects } from '../db/schema.js'
import { stripHtml } from './strip-html.js'

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
  | 'quotation'
  | 'note'
  | 'shelved'

// ap_id path segments emitted by BookWyrm for federated Notes.
const SEG_GENERATEDNOTE = '%/generatednote/%'
const SEG_COMMENT = '%/comment/%'
const SEG_REVIEW = '%/review/%'
// A bare star rating federates as `/reviewrating/`, not `/rating/` — and `%/rating/%`
// cannot match it, because the character before "rating" is a "w". This read
// `'%/rating/%'` for as long as the module has existed, so `event_type: 'rating'`
// was a filter that could only ever return nothing. Verified against the box: four
// Rating objects, all at /reviewrating/, all public, all carrying a star and a book.
const SEG_RATING = '%/reviewrating/%'
const SEG_QUOTATION = '%/quotation/%'

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
  // BookWyrm stamps comment/review/note objects with the reader's shelf state at
  // post time ("read" / "reading" / "to-read"), carried on the AP object as
  // `readingStatus` (queried from objects.raw). This is the reliable finish signal:
  // a `read` comment is what BookWyrm renders as "finished reading" with that post's
  // date, even when no standalone "finished reading" generatednote was produced.
  readingStatus?: string | null
  // BookWyrm comments/reviews reference the book via `inReplyToBook` (the Edition
  // AP id) rather than an Edition tag, so it's the book-url source for those — and
  // the join key into book_metadata. Queried from objects.raw.
  inReplyToBook?: string | null
  // Quotation objects carry the quoted passage as `quote` (HTML). Even under
  // BookWyrm's "pure" serialization (type: Note) the field survives, so it's
  // queried from objects.raw and surfaced as a clean dedicated field — the post
  // content mashes quote + attribution + commentary together.
  quote?: string | null
  // Review titles arrive as the AP object's `name`. Queried from objects.raw.
  name?: string | null
  // Comments/quotations optionally carry the reader's position (`progress` +
  // `progressMode`, "PG" = pages). Rarely used, captured opportunistically.
  progress?: string | number | null
  progressMode?: string | null
}

export interface ReadingEvent {
  event_type: ReadingEventType
  book_title: string | null
  book_author: string | null
  bookwyrm_book_url: string | null
  comment: string | null
  reading_status: 'read' | 'reading' | 'to-read' | null
  quote: string | null
  review_title: string | null
  progress: number | null
  progress_mode: string | null
}

// Normalize the AP `readingStatus` value (plain "read"/"reading"/"to-read", or a
// shelf URL containing one of those) to our shelf enum.
export function normalizeReadingStatus(v: unknown): 'read' | 'reading' | 'to-read' | null {
  if (typeof v !== 'string') return null
  const s = v.toLowerCase()
  if (s.includes('to-read') || s.includes('want-to-read')) return 'to-read'
  if (s.includes('reading')) return 'reading'
  if (s.includes('read')) return 'read'
  return null
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
  } else if (ap.includes('/reviewrating/')) {
    event_type = 'rating'
  } else if (ap.includes('/quotation/')) {
    event_type = 'quotation'
  } else {
    return null // caller drops it
  }

  const { title, author, url } = extractBookMeta(row, content, row.inReplyToBook)
  const progressNum = row.progress != null && row.progress !== '' ? Number(row.progress) : null
  return {
    event_type,
    book_title: title,
    book_author: author,
    bookwyrm_book_url: url,
    comment:
      event_type === 'comment' || event_type === 'review' || event_type === 'quotation'
        ? content || null
        : null,
    reading_status: normalizeReadingStatus(row.readingStatus),
    quote:
      event_type === 'quotation' && typeof row.quote === 'string' && row.quote
        ? stripHtml(row.quote) || null
        : null,
    review_title: event_type === 'review' && row.name ? row.name : null,
    progress: progressNum != null && Number.isFinite(progressNum) ? progressNum : null,
    progress_mode: row.progressMode ?? null,
  }
}

// Book metadata extraction precedence: Edition tag -> attachment name -> content.
function extractBookMeta(
  row: ClassifierInput,
  content: string,
  inReplyToBook?: string | null,
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

  // Comments/reviews carry the book url in inReplyToBook, not an Edition tag.
  if (!url && typeof inReplyToBook === 'string' && inReplyToBook) url = inReplyToBook

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

// A classified event plus the per-row facts the collapse needs (publish time for
// recency, and any inline rating — joined from bookwyrm_objects, falling back to
// the raw AP object's `rating` field, which survives pure serialization).
export interface DerivedReadingEvent {
  event: ReadingEvent
  publishedAt: Date | null
  rating: string | null
}

// One start→finish pass through a book, derived from the event stream. `started`
// is null for a finish-only cycle (the book was finished without a recorded
// "reading" signal — e.g. shelved straight to read).
export interface ReadingCycle {
  started: Date | null
  finished: Date | null
  cycle: number // 1-based ordinal per book; >1 means a reread
}

// One current-state record per book, the shape get_actor_reading_status returns.
export interface CollapsedBook {
  title: string | null
  author: string | null
  url: string | null
  cover: string | null
  shelf: 'reading' | 'read' | 'to-read' | null
  started: Date | null
  finished: Date | null
  rating: string | null
  lastActivity: Date | null // newest event time, for ordering
  cycles: ReadingCycle[] // every start→finish pass, oldest first (rereads = >1)
}

// Shelf-transition signals. BookWyrm's explicit `readingStatus` (carried on
// comments/reviews/quotations too) is preferred over the generatednote
// event_type, so a "read" comment counts as a finish. A review counts as a
// finish even without a readingStatus — posting a review implies the book was
// read (Markus's decision; matches how BookWyrm renders review dates).
export const isFinishSignal = (ev: ReadingEvent): boolean =>
  ev.reading_status === 'read' || ev.event_type === 'finished_reading' || ev.event_type === 'review'
export const isStartSignal = (ev: ReadingEvent): boolean =>
  !isFinishSignal(ev) && (ev.reading_status === 'reading' || ev.event_type === 'started_reading')
export const isShelveSignal = (ev: ReadingEvent): boolean =>
  !isFinishSignal(ev) && !isStartSignal(ev) &&
  (ev.reading_status === 'to-read' || ev.event_type === 'shelved')

/**
 * Derive start→finish cycles for ONE book from its event stream (any order;
 * events without a publish time are skipped — they can't be placed on a
 * timeline). Chronological scan: a start signal opens a cycle (subsequent
 * "reading" posts — progress comments — don't reset it); the first finish
 * signal closes it. A finish with no open cycle and no prior cycle becomes a
 * finish-only cycle (started: null). A finish signal after a closed cycle with
 * no new start in between is a post-finish comment (Markus posts review links
 * after finishing) and is ignored — only an intervening start opens a reread.
 */
export function deriveReadingCycles(events: DerivedReadingEvent[]): ReadingCycle[] {
  const dated = events
    .filter((e): e is DerivedReadingEvent & { publishedAt: Date } => e.publishedAt != null)
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())

  const cycles: ReadingCycle[] = []
  let open: Date | null = null
  for (const { event: ev, publishedAt: at } of dated) {
    if (isFinishSignal(ev)) {
      if (open) {
        cycles.push({ started: open, finished: at, cycle: cycles.length + 1 })
        open = null
      } else if (cycles.length === 0) {
        cycles.push({ started: null, finished: at, cycle: 1 })
      }
      // else: finish re-affirmation after an already-closed cycle — ignored
    } else if (isStartSignal(ev)) {
      open ??= at
    }
  }
  if (open) cycles.push({ started: open, finished: null, cycle: cycles.length + 1 })
  return cycles
}

/**
 * Collapse a book's event stream into one current-state record per distinct book.
 *
 * BookWyrm federates each reading action as its own Note, so a single book yields
 * many events (started/finished generatednotes carry an Edition tag → book url;
 * comments/reviews are often title-only with no url). We key by normalized title
 * (falling back to the book url) so those variants merge instead of producing a
 * duplicate row each. Within a book: the most recent shelf-changing event wins;
 * rating/url/author are coalesced to the first non-null seen so a later event
 * missing a field never blanks an earlier one. Dates come from the derived
 * reading cycles: `started` = first recorded start, `finished` = last cycle's
 * finish (so a post-finish comment doesn't drag the finish date later, and a
 * reread's most recent finish wins). Order-independent.
 */
export function collapseReadingEvents(events: DerivedReadingEvent[]): CollapsedBook[] {
  type Acc = CollapsedBook & { shelfAt: Date | null; events: DerivedReadingEvent[] }
  const byBook = new Map<string, Acc>()

  for (const item of events) {
    const { event: ev, publishedAt: at, rating } = item
    const key = normalizeTitle(ev.book_title) || ev.bookwyrm_book_url
    if (!key) continue // no title and no url — goal notes etc.

    let acc = byBook.get(key)
    if (!acc) {
      acc = {
        title: ev.book_title,
        author: ev.book_author,
        url: ev.bookwyrm_book_url,
        cover: null, // no cover source in the local store; live shelf supplies it
        shelf: null,
        shelfAt: null,
        started: null,
        finished: null,
        rating: null,
        lastActivity: null,
        cycles: [],
        events: [],
      }
      byBook.set(key, acc)
    }
    acc.title ??= ev.book_title
    acc.author ??= ev.book_author
    acc.url ??= ev.bookwyrm_book_url
    acc.rating ??= rating
    acc.events.push(item)

    // The current shelf is whatever the most recent shelf-affecting event set it to.
    const shelfForEvent = isFinishSignal(ev)
      ? 'read'
      : isStartSignal(ev)
        ? 'reading'
        : isShelveSignal(ev)
          ? 'to-read'
          : null
    if (shelfForEvent && (!acc.shelfAt || (at && at > acc.shelfAt))) {
      acc.shelf = shelfForEvent
      acc.shelfAt = at ?? acc.shelfAt
    }
    if (at && (!acc.lastActivity || at > acc.lastActivity)) acc.lastActivity = at
  }

  return [...byBook.values()].map(({ shelfAt: _shelfAt, events: bookEvents, ...book }) => {
    const cycles = deriveReadingCycles(bookEvents)
    const started = cycles.find((c) => c.started)?.started ?? null
    const finished = [...cycles].reverse().find((c) => c.finished)?.finished ?? null
    return { ...book, started, finished, cycles }
  })
}

/**
 * Index collapsed books by both Edition URL and normalized title, so callers
 * merging against another source (the live shelf, an event stream) can look up
 * by whichever key that source has. URL entries are exact Edition AP ids; title
 * entries use `normalizeTitle`.
 */
export function indexCollapsedBooks(books: CollapsedBook[]): Map<string, CollapsedBook> {
  const index = new Map<string, CollapsedBook>()
  for (const b of books) {
    if (b.url && !index.has(b.url)) index.set(b.url, b)
    const t = normalizeTitle(b.title)
    if (t && !index.has(t)) index.set(t, b)
  }
  return index
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
    like(objects.apId, SEG_QUOTATION),
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
    case 'quotation':
      return like(objects.apId, SEG_QUOTATION)
  }
}

// Merge key for grouping events by book: lowercase, collapse whitespace, trim.
// No parenthetical stripping — kept conservative to avoid merging distinct books
// that share a base title. Returns '' for an absent/whitespace-only title so the
// caller can fall back to the book url.
export const normalizeTitle = (title: string | null): string =>
  (title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
