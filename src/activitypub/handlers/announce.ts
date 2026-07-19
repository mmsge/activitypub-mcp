import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { extractAttachments, extractTags } from '../../lib/object-fields.js'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

export async function handleAnnounce(activity: AnyObject): Promise<void> {
  const objectRef = activity.object
  if (!objectRef) return

  // object may be a URL string or an embedded object
  if (typeof objectRef === 'string') {
    // Try to fetch and store the announced object
    try {
      const res = await fetch(objectRef, {
        headers: { Accept: 'application/activity+json' },
      })
      if (res.ok) {
        const obj = await res.json() as AnyObject
        await storeAnnouncedObject(obj, activity.actor as string)
      }
    } catch (e) {
      logger.debug({ url: objectRef, error: e }, 'Could not fetch announced object')
    }
  } else if (typeof objectRef === 'object') {
    await storeAnnouncedObject(objectRef as AnyObject, activity.actor as string)
  }
}

async function storeAnnouncedObject(obj: AnyObject, actorApId: string): Promise<void> {
  const apId = (obj.id ?? obj['@id']) as string
  if (!apId) return
  const type = (obj.type as string) ?? 'Note'
  const db = getDb()
  await db.insert(objects).values({
    apId,
    type,
    actorApId: (obj.attributedTo as string) ?? actorApId,
    content: (obj.content as string) ?? null,
    contentText: null,
    summary: (obj.summary as string) ?? null,
    url: (obj.url as string) ?? null,
    inReplyTo: (obj.inReplyTo as string) ?? null,
    publishedAt: obj.published ? new Date(obj.published as string) : null,
    attachments: extractAttachments(obj),
    tags: extractTags(obj),
    raw: obj,
  }).onConflictDoNothing()
}
