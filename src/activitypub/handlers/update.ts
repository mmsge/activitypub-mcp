import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { ingestObject } from './create.js'
import { objectApId, resolveRef } from '../../lib/ap-object.js'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

// `Update` also carries actor profile edits (Person/Service/…). Those are not posts and
// must never land in `objects`; actor records are refreshed by their own job.
const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Group', 'Organization'])

/**
 * An edit — and, for anything we have not seen before, a first sighting.
 *
 * `Update` is an upsert, not a patch (criterion 3). Treating it as a patch meant an edit
 * to a post we did not already hold silently updated nothing: a NeoDB mark made in the
 * UI arrived as `Update`/`Note`, was logged, and vanished. Marks are edited routinely on
 * NeoDB (a changed date, an added comment), and NeoDB re-sends the whole object, so the
 * same ingest that handles `Create` handles this — one row per post, updated in place.
 */
export async function handleUpdate(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return

  const apId = objectApId(obj)
  if (!apId) return

  const type = obj.type
  if (typeof type === 'string' && ACTOR_TYPES.has(type)) {
    logger.debug({ apId, type }, 'Ignoring actor Update (not a post)')
    return
  }

  // Attribution first, delivering actor second; for a payload with neither, fall back to
  // the actor already on the stored row so an edit still applies.
  let actorApId = resolveRef(obj.attributedTo) ?? resolveRef(activity.actor)
  if (!actorApId) {
    const db = getDb()
    const [existing] = await db
      .select({ actorApId: objects.actorApId })
      .from(objects)
      .where(eq(objects.apId, apId))
      .limit(1)
    actorApId = existing?.actorApId ?? null
  }
  if (!actorApId) {
    logger.debug({ apId }, 'Update with no resolvable actor, skipping')
    return
  }

  await ingestObject(obj, actorApId, { source: 'update' })
}
