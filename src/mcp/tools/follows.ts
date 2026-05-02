import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { follows, actors } from '../../db/schema.js'
import { eq } from 'drizzle-orm'

export const getFollowsSchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('accepted'),
})

export async function getFollows(input: z.infer<typeof getFollowsSchema>) {
  const db = getDb()
  const rows = await db
    .select({
      actorApId: follows.actorApId,
      status: follows.status,
      followedAt: follows.followedAt,
      acceptedAt: follows.acceptedAt,
      rejectedAt: follows.rejectedAt,
      handle: actors.handle,
      displayName: actors.displayName,
      iconUrl: actors.iconUrl,
      domain: actors.domain,
    })
    .from(follows)
    .leftJoin(actors, eq(follows.actorApId, actors.apId))

  const filtered = input.status === 'all'
    ? rows
    : rows.filter(r => r.status === input.status)

  return filtered
}
