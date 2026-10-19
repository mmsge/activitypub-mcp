import { and, eq, isNull, isNotNull, desc, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { objects, bookwyrmObjects, storygraphReads } from '../db/schema.js'
import {
  classifyReadingEvent,
  collapseReadingEvents,
  readingEventBaseCondition,
  type DerivedReadingEvent,
  type CollapsedBook,
} from './bookwyrm-reading.js'
import { collapseKey, mergeStorygraphReads } from './storygraph-reads.js'
import { rangeKey, type StorygraphReadRange } from './parse-storygraph-csv.js'

// Shared loader for every reading tool: pull an actor's stored BookWyrm posts
// from the generic `objects` store and classify them into reading events. The
// rating coalesces the structured bookwyrm_objects row (populated only for
// full-flavor federation) with the raw AP object's `rating` field, which
// survives BookWyrm's "pure" serialization — so an inline review rating is
// never lost just because the post federated as a plain Note/Article.
export async function loadDerivedReadingEvents(actorApId: string): Promise<DerivedReadingEvent[]> {
  const db = getDb()
  const rows = await db
    .select({
      apId: objects.apId,
      contentText: objects.contentText,
      tags: objects.tags,
      attachments: objects.attachments,
      publishedAt: objects.publishedAt,
      rating: sql<string | null>`coalesce(${bookwyrmObjects.rating}::text, ${objects.raw}->>'rating')`,
      readingStatus: sql<string | null>`${objects.raw}->>'readingStatus'`,
      inReplyToBook: sql<string | null>`${objects.raw}->>'inReplyToBook'`,
      quote: sql<string | null>`${objects.raw}->>'quote'`,
      name: sql<string | null>`${objects.raw}->>'name'`,
      progress: sql<string | null>`${objects.raw}->>'progress'`,
      progressMode: sql<string | null>`${objects.raw}->>'progressMode'`,
    })
    .from(objects)
    .leftJoin(bookwyrmObjects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(and(eq(objects.actorApId, actorApId), isNull(objects.deletedAt), readingEventBaseCondition()))
    .orderBy(desc(objects.publishedAt))

  return rows.flatMap((r) => {
    const event = classifyReadingEvent({
      apId: r.apId,
      content: r.contentText,
      tags: r.tags,
      attachments: r.attachments,
      readingStatus: r.readingStatus,
      inReplyToBook: r.inReplyToBook,
      quote: r.quote,
      name: r.name,
      progress: r.progress,
      progressMode: r.progressMode,
    })
    return event ? [{ event, publishedAt: r.publishedAt, rating: r.rating }] : []
  })
}

// BookWyrm alone: one collapsed row per book, dates derived from public statuses only.
// The StoryGraph import matches against this, so a match never depends on an earlier
// import's merge.
export async function loadBookwyrmBooks(actorApId: string): Promise<CollapsedBook[]> {
  return collapseReadingEvents(await loadDerivedReadingEvents(actorApId))
}

// The actor's matched StoryGraph reads, grouped by the BookWyrm collapse key they
// matched at import. Unmatched rows are not read: they belong to the import report.
export async function loadStorygraphReads(actorApId: string): Promise<Map<string, StorygraphReadRange[]>> {
  const rows = await getDb()
    .select({ key: storygraphReads.matchedKey, started: storygraphReads.startedOn, finished: storygraphReads.finishedOn })
    .from(storygraphReads)
    .where(and(eq(storygraphReads.actorApId, actorApId), isNotNull(storygraphReads.matchedKey)))
  // Keyed by range within each book: the same read can be stored under two book keys
  // (an export that once gave a StoryGraph uid and now gives an ISBN), and counting it
  // twice would invent a reread.
  const byKey = new Map<string, Map<string, StorygraphReadRange>>()
  for (const r of rows) {
    if (!r.key) continue
    const ranges = byKey.get(r.key) ?? new Map<string, StorygraphReadRange>()
    const range = { started: r.started, finished: r.finished }
    ranges.set(rangeKey(range), range)
    byKey.set(r.key, ranges)
  }
  return new Map([...byKey].map(([k, v]) => [k, [...v.values()]]))
}

// One collapsed current-state row per book (with derived dates and reading
// cycles) for an actor — the shared source for the shelf, stats, and pace tools.
// StoryGraph's imported reads fill the dates BookWyrm lacks (ADR 0063); every tool
// built on this sees them, and BookWyrm's own dates always win.
export async function loadCollapsedBooks(actorApId: string): Promise<CollapsedBook[]> {
  const [books, reads] = await Promise.all([loadBookwyrmBooks(actorApId), loadStorygraphReads(actorApId)])
  if (reads.size === 0) return books
  return books.map((b) => {
    const key = collapseKey(b)
    const mine = key ? reads.get(key) : undefined
    return mine ? mergeStorygraphReads(b, mine).book : b
  })
}
