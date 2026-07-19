import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { stripHtml } from '../../lib/strip-html.js'
import { extractContent } from '../../lib/object-content.js'
import { extractAttachments, extractTags, extractLanguage } from '../../lib/object-fields.js'

type AnyObject = Record<string, unknown>

export async function handleUpdate(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  if (!obj || typeof obj !== 'object') return

  const apId = (obj.id ?? obj['@id']) as string
  if (!apId) return

  const content = extractContent(obj)
  const db = getDb()
  // An edit can change the media, the hashtags/mentions, the CW flag and the
  // language — not just the text. Re-derive every mutable structured field from
  // the edited object, or the stored row keeps stale `tags`/`attachments`: e.g.
  // a #hashtag added in an edit would never reach the `tag=` filter even though
  // the (refreshed) text carries it.
  await db.update(objects).set({
    content,
    contentText: content ? stripHtml(content) : null,
    summary: (obj.summary as string) ?? null,
    attachments: extractAttachments(obj),
    tags: extractTags(obj),
    sensitive: Boolean(obj.sensitive),
    language: extractLanguage(obj),
    updatedAtAp: obj.updated ? new Date(obj.updated as string) : new Date(),
    raw: obj,
    updatedAt: new Date(),
  }).where(eq(objects.apId, apId))
}
