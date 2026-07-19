import { getDb } from '../db/client.js'
import { objects, serverConfig } from '../db/schema.js'
import { extractAttachments, extractTags } from '../lib/object-fields.js'
import { logger } from '../lib/logger.js'
import { asc, eq, gt } from 'drizzle-orm'

// Bump this key when the tag/attachment extraction changes and stored rows need
// re-deriving from their raw jsonb.
const MARKER_KEY = 'tags_attachments_backfill_v1'
const BATCH_SIZE = 500

type AnyObject = Record<string, unknown>

/**
 * One-time re-derivation of stored `tags` and `attachments` from each object's
 * raw jsonb. Until now the Update (edit) handler refreshed a post's text but
 * left `tags`/`attachments` frozen at first-seen, so a hashtag added in an edit
 * (e.g. Markus tagging older train selfies `#TogSelfie` after the fact) never
 * reached the `tag=` filter — the post was stored, its text carried the tag,
 * but the structured `tags` array did not.
 *
 * `raw` is always the latest object seen (the edit handler overwrites it), so
 * re-extracting from `raw` restores the current media and hashtags. Guarded by
 * a server_config marker so it runs once. Only touches rows whose derived value
 * actually differs, and compares by value so identical arrays are left alone.
 */
export async function backfillTags(): Promise<void> {
  const db = getDb()
  const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
  if (marker) return

  let updated = 0
  let lastId: string | null = null
  for (;;) {
    const rows = await db
      .select({ id: objects.id, tags: objects.tags, attachments: objects.attachments, raw: objects.raw })
      .from(objects)
      .where(lastId ? gt(objects.id, lastId) : undefined)
      .orderBy(asc(objects.id))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      const raw = row.raw as AnyObject | null
      if (!raw || typeof raw !== 'object') continue
      const tags = extractTags(raw)
      const attachments = extractAttachments(raw)
      const tagsSame = JSON.stringify(tags) === JSON.stringify(row.tags ?? [])
      const attSame = JSON.stringify(attachments) === JSON.stringify(row.attachments ?? [])
      if (tagsSame && attSame) continue
      await db
        .update(objects)
        .set({ tags, attachments, updatedAt: new Date() })
        .where(eq(objects.id, row.id))
      updated++
    }
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoNothing()
  logger.info({ updated }, 'Tags/attachments backfill complete')
}
