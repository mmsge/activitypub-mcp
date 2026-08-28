import { z } from 'zod'
import { config, getOwnerInstanceHost } from '../../config.js'
import { parseStatusRef } from '../../lib/fetch-engagement.js'
import { loadThread } from '../../lib/thread-store.js'
import { isSettled, normaliseApId } from '../../lib/thread-context.js'
import type { QueryScope } from './scope.js'

/**
 * One thread's stored shape, as nodes and edges a renderer can feed straight into a
 * graph library.
 *
 * Every node carries its id, its permalink and its participant handle — and nothing
 * else. **The reply text is not here because it is nowhere**: the walker stores the
 * skeleton and the origin instance keeps the words, so a visualisation opens a node
 * live at its own instance when someone clicks it. See decision record 0057.
 */

export const getThreadTreeSchema = z.object({
  status: z.string()
    .describe("The root toot: its AP id, its permalink, or a bare numeric id resolved against OWNER_INSTANCE."),
})

export async function getThreadTree(
  input: z.infer<typeof getThreadTreeSchema>,
  scope?: QueryScope,
) {
  // Accept the same reference forms get_engagement does, then resolve to the canonical
  // AP id the walk keyed on. A permalink and an AP id are the same thread and must not
  // be two different answers.
  const ref = parseStatusRef(input.status, getOwnerInstanceHost())
  if ('error' in ref) return { error: ref.message }

  // The AP id first, then the id as given, then `(origin, status_id)` — which is the
  // only form a BARE numeric id can be looked up by, since its AP URL cannot be
  // synthesised without knowing the username.
  const candidates: Array<string | { origin: string; statusId: string }> = [
    ...[
      ref.candidateApId ? normaliseApId(ref.candidateApId) : null,
      normaliseApId(input.status),
    ].filter((v): v is string => v !== null),
    { origin: ref.origin, statusId: ref.statusId },
  ]

  for (const candidate of candidates) {
    const stored = await loadThread(candidate, { publicOnly: scope?.publicOnly })
    if (stored) return render(stored)
  }

  return {
    error: `No walked thread for ${input.status}. It may not be one of the tracked accounts' own root toots, or it may not have been walked yet — run the thread walk backfill.`,
    hint: `Tried ${ref.origin}/${ref.statusId} and ${candidates.filter(c => typeof c === 'string').join(', ') || 'no AP id form'}.`,
  }
}

function render(stored: NonNullable<Awaited<ReturnType<typeof loadThread>>>) {
  const { root, nodes } = stored

  return {
    root: {
      root_ap_id: root.rootApId,
      actor_ap_id: root.actorApId,
      url: root.url,
      published_at: root.publishedAt,
      /** The root toot's own text — his. No other node in this response carries any. */
      text: root.text,
    },
    stats: {
      node_count: root.nodeCount,
      external_node_count: root.externalNodeCount,
      max_depth: root.maxDepth,
      external_participant_count: root.externalParticipantCount,
      newest_node_at: root.newestNodeAt,
      settled: isSettled(root.newestNodeAt, config.THREAD_SETTLED_DAYS),
      walked_at: root.walkedAt,
    },
    // Nodes and edges as separate arrays: a force-directed or tree layout takes exactly
    // this pair, so a renderer needs no reshaping and no second query.
    nodes: nodes.map(n => ({
      id: n.statusApId,
      status_id: n.statusId,
      origin: n.origin,
      url: n.url,
      handle: n.handle,
      depth: n.depth,
      published_at: n.publishedAt,
      is_mine: n.isMine,
      /** True for the root, which is stored as node 0 of its own tree. */
      is_root: n.depth === 0,
    })),
    edges: nodes
      .filter(n => n.parentStatusApId !== null)
      .map(n => ({ from: n.parentStatusApId as string, to: n.statusApId })),
    participants: [...new Set(nodes.filter(n => !n.isMine).map(n => n.handle))].sort(),
  }
}
