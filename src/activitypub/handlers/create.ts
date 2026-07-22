import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { stripHtml } from '../../lib/strip-html.js'
import { extractContent } from '../../lib/object-content.js'
import { extractAttachments, extractTags, extractLanguage } from '../../lib/object-fields.js'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

const BOOKWYRM_TYPES = new Set([
  'Edition', 'Work', 'ShelfBook', 'ReadThrough', 'Review', 'Rating', 'Comment',
  'Quotation', 'GeneratedNote',
])

export async function handleCreate(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  if (!obj || typeof obj !== 'object') return

  const apId = (obj.id ?? obj['@id']) as string
  if (!apId) return

  const type = (obj.type as string) ?? 'Note'
  const actorApId = activity.actor as string
  const content = extractContent(obj) ?? ''
  const contentText = content ? stripHtml(content) : ''
  const publishedStr = (obj.published as string) ?? null
  const publishedAt = publishedStr ? new Date(publishedStr) : null
  const url = (obj.url as string) ?? null
  const inReplyTo = (obj.inReplyTo as string) ?? null
  const summary = (obj.summary as string) ?? null
  const sensitive = Boolean(obj.sensitive)
  const language = extractLanguage(obj)
  const attachments = extractAttachments(obj)
  const tags = extractTags(obj)

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
    attachments,
    tags,
    sensitive,
    language,
    raw: obj,
  }).onConflictDoUpdate({
    target: objects.apId,
    // Re-ingesting an object (a redelivery, an outbox re-crawl, or a Create that
    // arrives after an edit) must refresh the mutable fields too — not just the
    // text. Freezing `tags`/`attachments` at first-seen is what let a hashtag
    // added in an edit go missing from the `tag=` filter. `type` refreshes so a
    // row first seen under BookWyrm's "pure" serialization (Note/Article) can
    // upgrade to its native type (Comment/Review/Quotation) on a later re-ingest.
    set: { type, content, contentText, summary, attachments, tags, sensitive, language, updatedAt: new Date(), raw: obj },
  })

  // BookWyrm-specific extra data
  if (BOOKWYRM_TYPES.has(type)) {
    await handleBookwyrm(apId, type, obj, actorApId)
  }
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
