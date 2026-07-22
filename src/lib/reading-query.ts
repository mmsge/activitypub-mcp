import { and, eq, isNull, desc, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { objects, bookwyrmObjects } from '../db/schema.js'
import {
  classifyReadingEvent,
  collapseReadingEvents,
  readingEventBaseCondition,
  type DerivedReadingEvent,
  type CollapsedBook,
} from './bookwyrm-reading.js'

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

// One collapsed current-state row per book (with derived dates and reading
// cycles) for an actor — the shared source for the shelf, stats, and pace tools.
export async function loadCollapsedBooks(actorApId: string): Promise<CollapsedBook[]> {
  return collapseReadingEvents(await loadDerivedReadingEvents(actorApId))
}
