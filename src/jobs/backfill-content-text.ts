import { getDb } from '../db/client.js'
import { objects, bookwyrmObjects, serverConfig } from '../db/schema.js'
import { stripHtml } from '../lib/strip-html.js'
import { extractContent } from '../lib/object-content.js'
import { logger } from '../lib/logger.js'
import { asc, eq, gt } from 'drizzle-orm'

// Bump this key when the text-extraction pipeline changes again and stored
// rows need re-deriving from their raw jsonb.
const MARKER_KEY = 'content_text_backfill_v1'
const BATCH_SIZE = 500

type AnyObject = Record<string, unknown>

/**
 * One-time re-derivation of stored post text. Every objects row keeps the
 * original AP object as raw jsonb, so text extracted by an older, lossier
 * pipeline (entities left undecoded, contentMap ignored) can be regenerated
 * in place. Guarded by a server_config marker so it runs once per version.
 */
export async function backfillContentText(): Promise<void> {
  const db = getDb()
  const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
  if (marker) return

  let objectsUpdated = 0
  let lastId: string | null = null
  for (;;) {
    const rows = await db
      .select({ id: objects.id, content: objects.content, contentText: objects.contentText, raw: objects.raw })
      .from(objects)
      .where(lastId ? gt(objects.id, lastId) : undefined)
      .orderBy(asc(objects.id))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      const content = extractContent(row.raw as AnyObject) ?? ''
      const contentText = content ? stripHtml(content) : ''
      if (content === (row.content ?? '') && contentText === (row.contentText ?? '')) continue
      await db
        .update(objects)
        .set({ content, contentText, updatedAt: new Date() })
        .where(eq(objects.id, row.id))
      objectsUpdated++
    }
  }

  let reviewsUpdated = 0
  lastId = null
  for (;;) {
    const rows = await db
      .select({ id: bookwyrmObjects.id, reviewContent: bookwyrmObjects.reviewContent, raw: bookwyrmObjects.raw })
      .from(bookwyrmObjects)
      .where(lastId ? gt(bookwyrmObjects.id, lastId) : undefined)
      .orderBy(asc(bookwyrmObjects.id))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      const html = extractContent(row.raw as AnyObject)
      const reviewContent = html ? stripHtml(html) : null
      if (reviewContent === row.reviewContent) continue
      await db.update(bookwyrmObjects).set({ reviewContent }).where(eq(bookwyrmObjects.id, row.id))
      reviewsUpdated++
    }
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoNothing()
  logger.info({ objectsUpdated, reviewsUpdated }, 'Content-text backfill complete')
}
