import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { stripHtml } from '../../lib/strip-html.js'
import { extractContent } from '../../lib/object-content.js'
import { extractAttachments, extractTags, extractLanguage } from '../../lib/object-fields.js'
import { queueBookMetadataEnrichment } from '../../jobs/sync-book-metadata.js'
import { queueNeodbEnrichment, syncMarkTitles, collectNeodbTagHrefs, isNeodbBookUrl } from '../../jobs/sync-neodb-metadata.js'
import { isNeodbMark, parseNeodbMark } from '../../lib/neodb-mark.js'
import { upsertNeodbMark } from '../../jobs/sync-neodb-marks.js'
import { collectConcertUrls, isGigAttendance, parseGigAttendance } from '../../lib/gig-attendance.js'
import { upsertGigAttendance } from '../../jobs/sync-gig-attendances.js'
import { queueGigEnrichment } from '../../jobs/sync-gig-metadata.js'
import { objectApId, resolveRef } from '../../lib/ap-object.js'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

const BOOKWYRM_TYPES = new Set([
  'Edition', 'Work', 'ShelfBook', 'ReadThrough', 'Review', 'Rating', 'Comment',
  'Quotation', 'GeneratedNote',
])

// Which delivery brought the object in. Only `update` differs in behaviour (it stamps
// `updated_at_ap` even when the payload carries no `updated`); the field is otherwise
// carried for logging, because the three paths must store identically — a boosted mark
// and a pushed one have to end up as the same row.
export type IngestSource = 'create' | 'announce' | 'update'

export async function handleCreate(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  if (!obj || typeof obj !== 'object') return
  const actorApId = resolveRef(activity.actor) ?? resolveRef(obj.attributedTo)
  if (!actorApId) return
  await ingestObject(obj, actorApId, { source: 'create' })
}

/**
 * Store one AP object and run every derived-data pipeline it feeds — the single ingest
 * path shared by `Create`, `Announce` (after the boost is unwrapped) and `Update`.
 *
 * It exists because those three used to store objects three different ways: the boost
 * path wrote a stripped row (no text, no enrichment, no mark), and the edit path wrote
 * nothing at all when the post was new to us. A mark must produce the same row whichever
 * way it arrives, so all three funnel through here.
 *
 * The write is an upsert on `ap_id`, so an object seen twice — re-delivered, boosted
 * after being pushed, or edited — updates in place instead of duplicating. Nothing
 * filters on recency: `published_at` is taken from the object verbatim and is routinely
 * years in the past (NeoDB marks are backdated to the date watched).
 */
export async function ingestObject(
  obj: AnyObject,
  actorApId: string,
  opts: { source?: IngestSource } = {},
): Promise<void> {
  if (!obj || typeof obj !== 'object') return
  const source = opts.source ?? 'create'

  const apId = objectApId(obj)
  if (!apId) return

  const type = (obj.type as string) ?? 'Note'
  const content = extractContent(obj) ?? ''
  const contentText = content ? stripHtml(content) : ''
  const publishedAt = parseApDate(obj.published)
  const updatedAtAp = parseApDate(obj.updated) ?? (source === 'update' ? new Date() : null)
  const url = resolveRef(obj.url)
  const inReplyTo = resolveRef(obj.inReplyTo)
  const summary = (obj.summary as string) ?? null
  const sensitive = Boolean(obj.sensitive)
  const language = extractLanguage(obj)
  const attachments = extractAttachments(obj)
  const tags = extractTags(obj)

  // Re-ingesting an object (a redelivery, a boost of a post we already hold, an outbox
  // re-crawl, or an edit) must refresh the mutable fields too — not just the text.
  // Freezing `tags`/`attachments` at first-seen is what let a hashtag added in an edit go
  // missing from the `tag=` filter. `type` refreshes so a row first seen under BookWyrm's
  // "pure" serialization (Note/Article) can upgrade to its native type on a later
  // re-ingest. The nullable fields below are refreshed only when the incoming payload
  // actually carries them, so a thinner re-delivery can never blank a good row.
  const set: Record<string, unknown> = {
    type, summary, attachments, tags, sensitive, language, raw: obj, updatedAt: new Date(),
  }
  if (content) { set.content = content; set.contentText = contentText }
  if (publishedAt) set.publishedAt = publishedAt
  if (updatedAtAp) set.updatedAtAp = updatedAtAp
  if (url) set.url = url
  if (inReplyTo) set.inReplyTo = inReplyTo

  const db = getDb()
  await db.insert(objects).values({
    apId,
    type,
    actorApId,
    content,
    contentText,
    summary,
    url,
    inReplyTo,
    publishedAt,
    updatedAtAp,
    attachments,
    tags,
    sensitive,
    language,
    raw: obj,
  }).onConflictDoUpdate({
    target: objects.apId,
    set,
  })

  // BookWyrm-specific extra data
  if (BOOKWYRM_TYPES.has(type)) {
    await handleBookwyrm(apId, type, obj, actorApId)
  }

  // Kick off metadata enrichment for any Edition this object references that we
  // haven't cached yet (fire-and-forget — never blocks inbox handling).
  for (const bookUrl of collectEditionUrls(obj, tags)) {
    queueBookMetadataEnrichment(bookUrl)
  }

  // Same, for any NeoDB catalog item (film/TV/music/game/podcast/performance, plus
  // NeoDB book Editions) this mark references. Also refresh the retained mark-title
  // aliases from the now-stored object, so a later mark under a new name accumulates
  // onto an already-enriched row (which the enrichment staleness guards would skip).
  for (const itemUrl of collectNeodbTagHrefs(tags)) {
    queueNeodbEnrichment(itemUrl)
    void syncMarkTitles(itemUrl).catch((e) =>
      logger.warn({ itemUrl, error: e }, 'On-ingest mark-title sync failed'))
  }

  // A NeoDB mark (a Note carrying the relatedWith Status extension) is upserted into the
  // per-actor watched/reading store keyed on (item url, actor). Ordinary Notes have no
  // `relatedWith` and fall straight through — no change to normal post ingestion. The
  // upsert also enqueues enrichment so the catalogue row backing get_watched is created.
  if (isNeodbMark(obj)) {
    const mark = parseNeodbMark(obj, actorApId)
    if (mark) {
      try {
        await upsertNeodbMark(mark)
        logger.debug({ apId, itemUrl: mark.itemUrl, status: mark.status, source }, 'Ingested NeoDB mark')
      } catch (e) {
        logger.warn({ apId, itemUrl: mark.itemUrl, error: e }, 'Failed to upsert NeoDB mark')
      }
    }
  }

  // Same, for a Gigowl gig attendance — a Note whose tags carry a `Link` named "Konsert"
  // pointing at the concert. An ordinary Note has no such tag and falls straight through.
  // The upsert enqueues enrichment, which dereferences the concert (and its venue and
  // artists) into the catalogue the gig tools read.
  for (const concertUrl of collectConcertUrls(obj)) {
    queueGigEnrichment(concertUrl)
  }
  if (isGigAttendance(obj)) {
    const attendance = parseGigAttendance(obj, actorApId)
    if (attendance) {
      try {
        await upsertGigAttendance(attendance)
        logger.debug(
          { apId, concertUrl: attendance.concertUrl, status: attendance.status, statusSource: attendance.statusSource, source },
          'Ingested gig attendance',
        )
      } catch (e) {
        logger.warn({ apId, concertUrl: attendance.concertUrl, error: e }, 'Failed to upsert gig attendance')
      }
    }
  }
}

// An AP timestamp, or null when absent/unparseable. Dates are taken verbatim: a mark is
// routinely backdated by years, so nothing here may clamp or reject an old one.
function parseApDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// Every way an ingested object can reference a BookWyrm Edition: comments and
// reviews carry `inReplyToBook`, generatednotes an Edition tag href, ReadThroughs
// a nested `book` object. NeoDB book Editions are excluded — they route to the NeoDB
// pipeline (which dedupes them against this cache), not this one.
function collectEditionUrls(obj: AnyObject, tags: unknown): string[] {
  const urls = new Set<string>()
  if (typeof obj.inReplyToBook === 'string' && obj.inReplyToBook) urls.add(obj.inReplyToBook)
  const book = obj.book as AnyObject | null
  const bookUrl = (book?.id ?? book?.url) as string | undefined
  if (typeof bookUrl === 'string' && bookUrl) urls.add(bookUrl)
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = t as AnyObject
    if (tag?.type === 'Edition' && typeof tag.href === 'string' && tag.href) urls.add(tag.href)
  }
  return [...urls].filter((u) => !isNeodbBookUrl(u))
}

async function handleBookwyrm(
  objectApId: string,
  bwType: string,
  obj: AnyObject,
  _actorApId: string
): Promise<void> {
  const db = getDb()
  try {
    const bookTitle = extractBookTitle(obj)
    const bookAuthor = extractBookAuthor(obj)
    const bookIsbn = (obj.isbn13 as string) ?? (obj.isbn10 as string) ?? null
    const bookUrl = (obj.url as string) ?? ((obj.book as AnyObject)?.url as string) ?? null
    const rating = extractRating(obj)
    const readingStatus = extractReadingStatus(obj, bwType)
    const startDate = extractDate(obj, 'startedDate')
    const finishDate = extractDate(obj, 'finishedDate')
    const progress = extractProgress(obj)
    const progressMode = extractProgressMode(obj)
    const reviewHtml = extractContent(obj)
    const reviewContent = reviewHtml ? stripHtml(reviewHtml) : null

    await db.insert(bookwyrmObjects).values({
      objectApId,
      bwType,
      bookTitle,
      bookAuthor,
      bookIsbn,
      bookUrl,
      rating: rating !== null ? String(rating) : null,
      readingStatus,
      startDate,
      finishDate,
      progress,
      progressMode,
      reviewContent,
      raw: obj,
    }).onConflictDoUpdate({
      target: bookwyrmObjects.objectApId,
      set: {
        readingStatus,
        progress,
        finishDate,
        bookUrl,
        rating: rating !== null ? String(rating) : null,
        reviewContent,
        raw: obj,
      },
    })
  } catch (e) {
    logger.warn({ objectApId, error: e }, 'Failed to parse BookWyrm object')
  }
}

function extractBookTitle(obj: AnyObject): string | null {
  // ReadThrough -> book -> title
  const book = obj.book as AnyObject | null
  if (book?.title) return book.title as string
  if (book?.name) return book.name as string
  // Edition
  if (obj.title) return obj.title as string
  return null
}

function extractBookAuthor(obj: AnyObject): string | null {
  const book = obj.book as AnyObject | null
  if (book?.authors) {
    const authors = book.authors as AnyObject[] | string[]
    if (Array.isArray(authors) && authors.length > 0) {
      const a = authors[0]
      return typeof a === 'string' ? a : (a as AnyObject).name as string ?? null
    }
  }
  return null
}

function extractRating(obj: AnyObject): number | null {
  const r = obj.rating as number | string | null
  if (r == null) return null
  const n = Number(r)
  return isNaN(n) ? null : n
}

function extractReadingStatus(obj: AnyObject, bwType: string): string | null {
  const shelf = obj.readingStatus as string
    ?? obj.shelf as string
    ?? null
  if (shelf) {
    // Ordered, and stopped first — the words nest, so "stopped-reading" contains
    // "reading" and would otherwise be stored as `reading`. This is the copy that
    // puts the value on disk, so getting the order wrong here is the only one of
    // the three that survives a restart. Mirrors normalizeReadingStatus in
    // lib/bookwyrm-reading.ts; the two must stay in step.
    if (shelf.includes('stopped')) return 'stopped-reading'
    if (shelf.includes('to-read') || shelf.includes('want-to-read')) return 'to-read'
    if (shelf.includes('reading')) return 'reading'
    if (shelf.includes('read')) return 'read'
  }
  if (bwType === 'ReadThrough') {
    const finished = obj.finishedDate as string | null
    if (finished) return 'read'
    return 'reading'
  }
  return null
}

function extractDate(obj: AnyObject, field: string): string | null {
  const v = obj[field] as string | null
  if (!v) return null
  return v.split('T')[0] // date only
}

function extractProgress(obj: AnyObject): number | null {
  const updates = obj.progressUpdates as AnyObject[] | null
  if (updates && updates.length > 0) {
    const last = updates[updates.length - 1]
    const p = last.progress as number | string | null
    if (p != null) return Number(p)
  }
  const p = obj.progress as number | string | null
  if (p != null) return Number(p)
  return null
}

function extractProgressMode(obj: AnyObject): string | null {
  const updates = obj.progressUpdates as AnyObject[] | null
  if (updates && updates.length > 0) {
    return (updates[0].mode as string) ?? null
  }
  return null
}
