import { z } from 'zod'
import { config } from '../../config.js'
import { threadWalkBlockedReason } from '../../jobs/walk-threads.js'
import {
  lastWalkAt,
  loadLeaderboard,
  resolveThreadActors,
  threadCoverage,
  type LeaderboardRow,
  type LeaderboardSort,
} from '../../lib/thread-store.js'
import { isSettled } from '../../lib/thread-context.js'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import type { QueryScope } from './scope.js'

/**
 * Which of his own toots started the biggest conversation.
 *
 * `replies_count` counts direct children, so it cannot tell a toot that started an
 * argument from one that collected thirteen flat replies. This ranks on the walked tree
 * instead: total nodes, how many of them were somebody else's, how deep it went, and how
 * many people took part.
 *
 * The root's own text is included because it is his. **No reply text is returned, because
 * none is stored** — the walker keeps ids, links, depths and handles and nothing else,
 * and the schema's CHECK constraints keep it that way. See decision record 0057.
 */

export const getThreadLeaderboardSchema = z.object({
  sort: z.enum(['external_nodes', 'depth', 'participants']).default('external_nodes')
    .describe("Rank by external reply count (default), by maximum depth, or by how many distinct people took part."),
  limit: z.number().int().min(1).max(200).default(20)
    .describe('Maximum threads returned.'),
  days: z.number().int().min(1).max(3650).optional()
    .describe('Only threads whose ROOT was published within this many days. Omit for the whole archive.'),
  actor_handle: z.string().optional()
    .describe('Narrow to one of the tracked accounts (@user@domain or an actor URL).'),
})

function row(r: LeaderboardRow, settledDays: number) {
  return {
    root_ap_id: r.rootApId,
    actor_ap_id: r.actorApId,
    url: r.url,
    published_at: r.publishedAt,
    /** The ROOT toot's own text. There is no reply text in this response or in the store. */
    text: r.text,
    node_count: r.nodeCount,
    external_node_count: r.externalNodeCount,
    max_depth: r.maxDepth,
    external_participant_count: r.externalParticipantCount,
    newest_node_at: r.newestNodeAt,
    /** Settled threads are skipped by the daily pass; only a backfill revisits them. */
    settled: isSettled(r.newestNodeAt, settledDays),
    walked_at: r.walkedAt,
  }
}

export async function getThreadLeaderboard(
  input: z.infer<typeof getThreadLeaderboardSchema>,
  scope?: QueryScope,
) {
  let tracked = await resolveThreadActors()
  if (tracked.length === 0) {
    return {
      error: 'No thread actors resolved. Set THREAD_ACTORS (or OWNER_ACTOR) to an account this server has stored.',
    }
  }

  if (input.actor_handle) {
    const wanted = input.actor_handle.startsWith('http')
      ? input.actor_handle
      : (await resolveActorByHandle(input.actor_handle))?.apId
    if (!wanted) return { error: `Could not resolve actor: ${input.actor_handle}` }
    tracked = tracked.filter(a => a.apId === wanted)
    if (tracked.length === 0) return { error: `Not a tracked account: ${input.actor_handle}` }
  }

  const actorApIds = tracked.map(a => a.apId)
  const [threads, coverage, walkedAt] = await Promise.all([
    loadLeaderboard({
      sort: input.sort as LeaderboardSort,
      limit: input.limit,
      actorApIds,
      days: input.days,
      publicOnly: scope?.publicOnly,
    }),
    threadCoverage(actorApIds),
    lastWalkAt(),
  ])

  return {
    // The walk's own state, for the same reason get_scrobble_race reports its config: an
    // empty leaderboard because nothing has been walked yet and one because nothing drew
    // a reply look identical otherwise (record 0015).
    walk: {
      blocked_reason: threadWalkBlockedReason(),
      interval_hours: config.THREAD_WALK_INTERVAL_HOURS,
      settled_days: config.THREAD_SETTLED_DAYS,
      last_walk_at: walkedAt,
      roots_total: coverage.roots,
      roots_walked: coverage.walked,
      roots_unsettled: coverage.unsettled,
      roots_failing: coverage.failing,
    },
    actors: tracked.map(a => ({ actor_ap_id: a.apId, handle: a.handle })),
    sort: input.sort,
    /** Threads made only of his own replies score zero external nodes and are excluded. */
    threads: threads.map(r => row(r, config.THREAD_SETTLED_DAYS)),
  }
}
