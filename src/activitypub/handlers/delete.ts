import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { eq } from 'drizzle-orm'

type AnyObject = Record<string, unknown>

export async function handleDelete(activity: AnyObject): Promise<void> {
  const obj = activity.object
  const apId = typeof obj === 'string' ? obj : (obj as AnyObject)?.id as string
  if (!apId) return

  const db = getDb()
  await db.update(objects).set({ deletedAt: new Date() }).where(eq(objects.apId, apId))
}
