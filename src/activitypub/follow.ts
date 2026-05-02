import { getDb } from '../db/client.js'
import { deliveryQueue, follows } from '../db/schema.js'
import { getActorUrl } from '../config.js'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'

export async function sendFollow(actorApId: string, inboxUrl: string, sharedInboxUrl?: string | null): Promise<void> {
  const db = getDb()
  const actorUrl = getActorUrl()
  const followId = `${actorUrl}#follow-${randomUUID()}`

  const followActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: followId,
    type: 'Follow',
    actor: actorUrl,
    object: actorApId,
  }

  await db.insert(follows).values({
    actorApId,
    followActivityId: followId,
    status: 'pending',
  }).onConflictDoNothing()

  await db.insert(deliveryQueue).values({
    inboxUrl: sharedInboxUrl ?? inboxUrl,
    payload: followActivity,
  })
}

export async function sendUnfollow(actorApId: string, inboxUrl: string): Promise<void> {
  const db = getDb()
  const actorUrl = getActorUrl()

  const [follow] = await db.select().from(follows).where(
    eq(follows.actorApId, actorApId)
  ).limit(1)

  if (!follow) return

  const undoActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}#undo-follow-${randomUUID()}`,
    type: 'Undo',
    actor: actorUrl,
    object: {
      id: follow.followActivityId,
      type: 'Follow',
      actor: actorUrl,
      object: actorApId,
    },
  }

  await db.insert(deliveryQueue).values({ inboxUrl, payload: undoActivity })
  await db.delete(follows).where(eq(follows.actorApId, actorApId))
}
