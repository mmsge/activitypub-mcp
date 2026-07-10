import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { follows, actors } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { serviceLabel } from '../../lib/fetch-nodeinfo.js'

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
      software: actors.software,
    })
    .from(follows)
    .leftJoin(actors, eq(follows.actorApId, actors.apId))

  const filtered = input.status === 'all'
    ? rows
    : rows.filter(r => r.status === input.status)

  // `service` is the human-facing platform label (e.g. "BookWyrm", "Mastodon"), derived
  // from the origin's NodeInfo software — so a caller can tell at a glance which followed
  // account belongs to which service. Null until the software has been probed.
  return filtered.map(r => ({ ...r, service: serviceLabel(r.software) }))
}
