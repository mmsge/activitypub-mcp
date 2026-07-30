import { ingestObject } from './create.js'
import { fetchApObject } from '../../lib/fetch-ap-object.js'
import { isBareReference, objectApId, resolveRef } from '../../lib/ap-object.js'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

/**
 * A boost. The interesting part is never the `Announce` itself but the object inside it,
 * so the wrapper is unpacked and the inner object stored exactly as if it had been
 * pushed to us directly — same text, same tags, same NeoDB mark, same catalogue
 * enrichment (criterion 2). The boost creates no post of its own: the inner object is
 * stored under its own id, so a post that is both pushed and boosted stays one row.
 *
 * Mastodon sends the boosted post as a bare URI, so it has to be dereferenced. Before
 * this unpacking existed the boost path wrote a stripped row straight from whatever the
 * wrapper held — no text, no enrichment, no mark — which is how 27 boosted film marks
 * ended up stored but invisible to get_watched.
 */
export async function handleAnnounce(activity: AnyObject): Promise<void> {
  const objectRef = activity.object
  if (!objectRef) return
  const announcer = resolveRef(activity.actor)

  let obj: AnyObject | null = null
  if (typeof objectRef === 'string') {
    obj = await fetchApObject(objectRef)
  } else if (typeof objectRef === 'object' && !Array.isArray(objectRef)) {
    obj = objectRef as AnyObject
    // Some implementations embed only `{id, type}`. Resolve it, or we'd store a
    // contentless row — and overwrite a good one if we already held the post.
    if (isBareReference(obj)) {
      const id = objectApId(obj)
      obj = (id ? await fetchApObject(id) : null) ?? obj
    }
  }

  if (!obj) return
  const apId = objectApId(obj)
  if (!apId) return
  if (isBareReference(obj)) {
    logger.debug({ apId }, 'Announced object could not be resolved to a full object, skipping')
    return
  }

  // The boosted post belongs to its author, not to whoever boosted it — this is what
  // keeps a boosted NeoDB mark filed under the NeoDB actor. The announcer is only a
  // fallback for a payload with no attribution at all.
  const actorApId = resolveRef(obj.attributedTo) ?? announcer
  if (!actorApId) return

  await ingestObject(obj, actorApId, { source: 'announce' })
}
