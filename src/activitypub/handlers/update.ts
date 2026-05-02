import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { stripHtml } from '../../lib/strip-html.js'

type AnyObject = Record<string, unknown>

export async function handleUpdate(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  if (!obj || typeof obj !== 'object') return

  const apId = (obj.id ?? obj['@id']) as string
  if (!apId) return

  const content = (obj.content as string) ?? null
  const db = getDb()
  await db.update(objects).set({
    content,
    contentText: content ? stripHtml(content) : null,
    summary: (obj.summary as string) ?? null,
    updatedAtAp: obj.updated ? new Date(obj.updated as string) : new Date(),
    raw: obj,
    updatedAt: new Date(),
  }).where(eq(objects.apId, apId))
}
