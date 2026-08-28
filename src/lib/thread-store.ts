import { and, asc, desc, eq, gt, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm'
import { config, getThreadActors } from '../config.js'
import { getDb } from '../db/client.js'
import { actors, follows, objects, threadNodes, threadRoots } from '../db/schema.js'
import { SAMPLED_TYPES } from '../jobs/sample-engagement.js'
import { handleFromActorApId, splitApId } from './thread-context.js'
import type { ThreadNode, ThreadStats } from './thread-context.js'

/**
 * Database access for the thread walker and the two tools that read what it wrote.
 *
 * The one thing worth knowing before changing anything here: a walk REPLACES a thread's
 * node rows inside a single transaction. That is what makes a deleted reply disappear on
 * the next walk with nothing tombstoned, and it is why a failed fetch must never reach
 * `replaceThread` — an empty node list would erase a good tree. `recordWalkFailure` is
 * the other path, and it touches the bookkeeping columns only.
 *
 * See decision record 0057.
 */

/** Object types that can root a conversation — the engagement sampler's list minus the
 *  BookWyrm/NeoDB bibliographic records, which are not toots and never draw a thread. */
export const ROOT_TYPES = SAMPLED_TYPES.filter(t => t !== 'GeneratedNote')

/** Only public and unlisted roots are walked, matching the replies. */
export const ROOT_VISIBILITIES = ['public', 'unlisted']

/** Rows per INSERT when replacing a thread's nodes. See `replaceThread`. */
const NODE_INSERT_CHUNK = 1000

export interface ThreadActor {
  apId: string
  /** `@user@host`, lowercase. Derived from the actor id when the stored row carries no
   *  handle, so "is this node mine?" never depends on a field that happens to be null. */
  handle: string
  /** Where this actor came from: named in THREAD_ACTORS/OWNER_ACTOR, or picked up from
   *  the followed-accounts fallback. Reported, so "why is it walking that?" is answerable. */
  source: 'configured' | 'followed'
}

/**
 * Which stored actors a configured entry names. Pure, so the spellings that do and do not
 * match are assertable without a database — that is the whole failure mode this function
 * exists to make legible.
 *
 * An entry is either an actor URL or a handle, and both are matched forgivingly, because
 * every spelling below names the same account and a mismatch is otherwise a silent
 * "no actors":
 *
 *   - a handle, case-insensitively, with the leading `@` optional on both sides — `.env`
 *     files are written by people, and `markus@skvip.lol` is the same account;
 *   - an actor URL, against `ap_id` exactly;
 *   - an actor URL that is NOT the stored `ap_id`, by the handle derived from it — which
 *     is what rescues the profile URL a person copies out of a browser
 *     (`https://skvip.lol/@markus`) against the id the archive keys on
 *     (`https://skvip.lol/users/markus`).
 */
export function matchThreadActors(
  configured: string[],
  rows: Array<{ apId: string; handle: string | null }>,
): ThreadActor[] {
  const urls = new Set(configured.filter(c => c.startsWith('http')))
  const handles = new Set(
    configured
      .filter(c => !c.startsWith('http'))
      .map(h => `@${h.trim().replace(/^@/, '').toLowerCase()}`),
  )
  // A URL entry also matches by its DERIVED handle. `OWNER_ACTOR` is documented as
  // accepting "an @user@domain handle or an actor URL", and the profile URL
  // (`https://skvip.lol/@markus`) is the one a person copies out of a browser — but the
  // archive keys on the actor id (`https://skvip.lol/users/markus`). Matching those two
  // spellings only by string equality is a silence with no visible cause.
  for (const url of urls) {
    const derived = handleFromActorApId(url)?.toLowerCase()
    if (derived) handles.add(derived)
  }

  const out: ThreadActor[] = []
  for (const r of rows) {
    const handle = normaliseStoredHandle(r.handle, r.apId)
    if (!urls.has(r.apId) && !(handle && handles.has(handle))) continue
    if (handle) out.push({ apId: r.apId, handle, source: 'configured' })
  }
  return out
}

/**
 * The outcome of working out whose toots are roots.
 *
 * Three states, not two. "No actors" collapses **nothing was configured** and
 * **something was configured and matched nothing** into one silence, and those have
 * completely different fixes: the first is an env var, the second is a handle that does
 * not look the way the archive spells it. Telling them apart — and listing what the
 * archive *does* hold — is the difference between a two-minute fix and a psql session.
 * ADR 0039's lesson, and ADR 0034's: two conditions that mean different things must not
 * be spelled the same way.
 */
export type ThreadActorResolution =
  | { kind: 'ok'; actors: ThreadActor[] }
  | { kind: 'unconfigured'; stored: string[] }
  | { kind: 'unmatched'; configured: string[]; stored: string[] }

/** `@user@host`, lowercase, however the row happens to spell it. */
function normaliseStoredHandle(handle: string | null, apId: string): string {
  const stored = handle ? (handle.startsWith('@') ? handle : `@${handle}`).toLowerCase() : ''
  return stored || handleFromActorApId(apId)?.toLowerCase() || ''
}

/**
 * Whose toots are roots.
 *
 * Resolved against the stored `actors` table rather than over WebFinger: the walker runs
 * on a timer and must not depend on a remote lookup to know whose archive it is reading.
 *
 * With nothing configured it falls back to every **accepted follow running Mastodon** —
 * the auto-watchlist `sampleEngagement` already uses, narrowed by `software` because the
 * context endpoint is a Mastodon API and asking a BookWyrm or NeoDB account for one would
 * only manufacture walk errors. Every stored actor is an account this server was pointed
 * at deliberately, so that fallback is his own accounts and nobody else's.
 */
export async function resolveThreadActorsDetailed(): Promise<ThreadActorResolution> {
  const rows = await getDb()
    .select({ apId: actors.apId, handle: actors.handle, software: actors.software })
    .from(actors)
  const stored = rows.map(r => normaliseStoredHandle(r.handle, r.apId)).filter(Boolean).sort()

  const configured = getThreadActors()

  if (configured.length === 0) {
    // The fallback. Accepted follows only — the inbox rejects everyone else, so these are
    // accounts this server was pointed at on purpose.
    const accepted = await getDb()
      .select({ apId: follows.actorApId })
      .from(follows)
      .where(eq(follows.status, 'accepted'))
    const acceptedIds = new Set(accepted.map(f => f.apId))

    const out = rows
      .filter(r => acceptedIds.has(r.apId) && r.software === 'mastodon')
      .flatMap((r) => {
        const handle = normaliseStoredHandle(r.handle, r.apId)
        return handle ? [{ apId: r.apId, handle, source: 'followed' as const }] : []
      })

    return out.length > 0 ? { kind: 'ok', actors: out } : { kind: 'unconfigured', stored }
  }

  const out = matchThreadActors(configured, rows)

  // Configured and matched nothing. That is a different failure from configuring nothing,
  // and the stored handles are what makes it fixable without opening psql.
  return out.length > 0 ? { kind: 'ok', actors: out } : { kind: 'unmatched', configured, stored }
}

/** The resolved actors, or an empty list. For callers that only need the happy path. */
export async function resolveThreadActors(): Promise<ThreadActor[]> {
  const result = await resolveThreadActorsDetailed()
  return result.kind === 'ok' ? result.actors : []
}

export interface RootToWalk {
  apId: string
  actorApId: string
  statusId: string
  origin: string
  url: string | null
  publishedAt: Date | null
  /** Null until the thread has been walked once. */
  walkedAt: Date | null
  newestNodeAt: Date | null
}

export type WalkMode = 'backfill' | 'incremental'

/**
 * The work queue.
 *
 * `incremental` takes roots never walked, plus roots whose newest known node is under
 * THREAD_SETTLED_DAYS old. Everything else is settled and skipped, which is the only
 * reason a daily job is not a repeat of the backfill — and it means a settled thread
 * that somehow gains a reply waits for the next backfill rather than the next night.
 *
 * `backfill` takes every root. Both orders by walk time, nulls first, so a run that stops
 * at its request budget resumes where it left off instead of re-walking the same head.
 */
export async function loadRootsToWalk(opts: {
  mode: WalkMode
  actorApIds: string[]
  limit: number
  settledDays?: number
}): Promise<RootToWalk[]> {
  if (opts.actorApIds.length === 0 || opts.limit <= 0) return []
  const settledDays = opts.settledDays ?? config.THREAD_SETTLED_DAYS

  const isRoot = and(
    inArray(objects.actorApId, opts.actorApIds),
    isNull(objects.inReplyTo),
    isNull(objects.deletedAt),
    inArray(objects.type, ROOT_TYPES),
    inArray(objects.visibility, ROOT_VISIBILITIES),
  )!

  const unsettled = or(
    isNull(threadRoots.walkedAt),
    isNull(threadRoots.newestNodeAt),
    gt(threadRoots.newestNodeAt, sql`now() - make_interval(days => ${settledDays})`),
  )!

  const rows = await getDb()
    .select({
      apId: objects.apId,
      actorApId: objects.actorApId,
      url: objects.url,
      publishedAt: objects.publishedAt,
      walkedAt: threadRoots.walkedAt,
      newestNodeAt: threadRoots.newestNodeAt,
    })
    .from(objects)
    .leftJoin(threadRoots, eq(threadRoots.rootApId, objects.apId))
    .where(opts.mode === 'incremental' ? and(isRoot, unsettled) : isRoot)
    // Nulls first: a root never walked outranks one walked long ago.
    .orderBy(sql`${threadRoots.walkedAt} asc nulls first`, desc(objects.publishedAt))
    .limit(opts.limit)

  // A root whose AP id does not yield an origin-local id cannot be asked about, and would
  // fail the schema's CHECK if stored. Dropped here rather than at INSERT time.
  return rows.flatMap((r) => {
    const parts = splitApId(r.apId)
    if (!parts) return []
    return [{
      apId: r.apId,
      actorApId: r.actorApId,
      statusId: parts.statusId,
      origin: parts.origin,
      url: r.url,
      publishedAt: r.publishedAt,
      walkedAt: r.walkedAt,
      newestNodeAt: r.newestNodeAt,
    }]
  })
}

/** How many roots exist, and how many of them are settled — the admin page's headline. */
export async function threadCoverage(actorApIds: string[]): Promise<{
  roots: number
  walked: number
  unsettled: number
  failing: number
}> {
  if (actorApIds.length === 0) return { roots: 0, walked: 0, unsettled: 0, failing: 0 }
  const settledDays = config.THREAD_SETTLED_DAYS

  // Built with the query builder rather than as one hand-written statement so the two
  // array predicates are parameterised the way `loadRootsToWalk` parameterises them —
  // `inArray` and a raw `= ANY(...)` do NOT bind a JS array the same way.
  const [row] = await getDb()
    .select({
      roots: sql<number>`count(*)::int`,
      walked: sql<number>`count(${threadRoots.walkedAt})::int`,
      unsettled: sql<number>`count(*) FILTER (
        WHERE ${threadRoots.walkedAt} IS NULL
           OR ${threadRoots.newestNodeAt} IS NULL
           OR ${threadRoots.newestNodeAt} > now() - make_interval(days => ${settledDays})
      )::int`,
      failing: sql<number>`count(*) FILTER (WHERE ${threadRoots.walkError} IS NOT NULL)::int`,
    })
    .from(objects)
    .leftJoin(threadRoots, eq(threadRoots.rootApId, objects.apId))
    .where(and(
      inArray(objects.actorApId, actorApIds),
      isNull(objects.inReplyTo),
      isNull(objects.deletedAt),
      inArray(objects.type, ROOT_TYPES),
      inArray(objects.visibility, ROOT_VISIBILITIES),
    ))

  return {
    roots: row?.roots ?? 0,
    walked: row?.walked ?? 0,
    unsettled: row?.unsettled ?? 0,
    failing: row?.failing ?? 0,
  }
}

/**
 * Write one walked thread: the statistics on `thread_roots`, and the node set replaced
 * wholesale. One transaction, so a reader never sees half a tree and a crash never
 * leaves one.
 */
export async function replaceThread(
  root: RootToWalk,
  nodes: ThreadNode[],
  stats: ThreadStats,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .insert(threadRoots)
      .values({
        rootApId: root.apId,
        actorApId: root.actorApId,
        rootStatusId: root.statusId,
        origin: root.origin,
        nodeCount: stats.nodeCount,
        externalNodeCount: stats.externalNodeCount,
        maxDepth: stats.maxDepth,
        externalParticipantCount: stats.externalParticipantCount,
        newestNodeAt: stats.newestNodeAt,
        walkedAt: new Date(),
        walkAttempts: 0,
        walkError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: threadRoots.rootApId,
        set: {
          actorApId: root.actorApId,
          rootStatusId: root.statusId,
          origin: root.origin,
          nodeCount: stats.nodeCount,
          externalNodeCount: stats.externalNodeCount,
          maxDepth: stats.maxDepth,
          externalParticipantCount: stats.externalParticipantCount,
          newestNodeAt: stats.newestNodeAt,
          walkedAt: new Date(),
          // Cleared on success: the attempt counter measures a current failure, not a
          // lifetime tally, so a thread that recovers stops looking broken.
          walkAttempts: 0,
          walkError: null,
          updatedAt: new Date(),
        },
      })

    // Replace, don't merge. A reply deleted at its origin is absent from the new set and
    // therefore gone — criterion 4, and the reason nothing is tombstoned.
    await tx.delete(threadNodes).where(eq(threadNodes.rootApId, root.apId))
    if (nodes.length === 0) return

    const rows = nodes.map(n => ({
      rootApId: root.apId,
      statusApId: n.statusApId,
      statusId: n.statusId,
      origin: n.origin,
      url: n.url,
      parentStatusApId: n.parentStatusApId,
      depth: n.depth,
      publishedAt: n.publishedAt,
      handle: n.handle,
      isMine: n.isMine,
    }))
    // Chunked: a thread at Mastodon's own MAX_DESCENDANTS (4,096) is already 45,000 bind
    // parameters against a protocol ceiling of 65,535, and an instance that raised its
    // limit would take the insert past it. Still one transaction, so the replace is
    // still atomic.
    for (let i = 0; i < rows.length; i += NODE_INSERT_CHUNK) {
      await tx.insert(threadNodes).values(rows.slice(i, i + NODE_INSERT_CHUNK))
    }
  })
}

/**
 * Record that a walk failed, WITHOUT touching the stored tree. A 404 or a timeout must
 * not read as "this conversation is now empty": the previous shape stays until a walk
 * actually succeeds, and the error is visible at /admin/threads rather than showing up
 * as an absence.
 */
export async function recordWalkFailure(root: RootToWalk, message: string): Promise<void> {
  const error = message.slice(0, 500)
  await getDb()
    .insert(threadRoots)
    .values({
      rootApId: root.apId,
      actorApId: root.actorApId,
      rootStatusId: root.statusId,
      origin: root.origin,
      walkedAt: new Date(),
      walkAttempts: 1,
      walkError: error,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: threadRoots.rootApId,
      set: {
        walkedAt: new Date(),
        walkAttempts: sql`${threadRoots.walkAttempts} + 1`,
        walkError: error,
        updatedAt: new Date(),
      },
    })
}

export type LeaderboardSort = 'external_nodes' | 'depth' | 'participants'

export interface LeaderboardRow {
  rootApId: string
  actorApId: string
  url: string | null
  publishedAt: Date | null
  nodeCount: number
  externalNodeCount: number
  maxDepth: number
  externalParticipantCount: number
  newestNodeAt: Date | null
  walkedAt: Date | null
  /** The ROOT's own text, joined live from `objects`. It is his own toot; no reply text
   *  exists anywhere to join. */
  text: string | null
}

const SORT_COLUMN = {
  external_nodes: threadRoots.externalNodeCount,
  depth: threadRoots.maxDepth,
  participants: threadRoots.externalParticipantCount,
} as const

export async function loadLeaderboard(opts: {
  sort: LeaderboardSort
  limit: number
  actorApIds: string[]
  days?: number
  publicOnly?: boolean
}): Promise<LeaderboardRow[]> {
  if (opts.actorApIds.length === 0) return []

  const conditions = [
    inArray(threadRoots.actorApId, opts.actorApIds),
    // A thread of only his own replies scores zero and does not appear.
    gt(threadRoots.externalNodeCount, 0),
  ]
  if (opts.days !== undefined) {
    conditions.push(gt(objects.publishedAt, sql`now() - make_interval(days => ${opts.days})`))
  }
  if (opts.publicOnly) conditions.push(eq(objects.visibility, 'public'))

  const primary = SORT_COLUMN[opts.sort]
  const rows = await getDb()
    .select({
      rootApId: threadRoots.rootApId,
      actorApId: threadRoots.actorApId,
      url: objects.url,
      publishedAt: objects.publishedAt,
      nodeCount: threadRoots.nodeCount,
      externalNodeCount: threadRoots.externalNodeCount,
      maxDepth: threadRoots.maxDepth,
      externalParticipantCount: threadRoots.externalParticipantCount,
      newestNodeAt: threadRoots.newestNodeAt,
      walkedAt: threadRoots.walkedAt,
      text: objects.contentText,
    })
    .from(threadRoots)
    // Inner join: a root whose object has been deleted or hidden since the walk drops out
    // of the leaderboard rather than appearing as a row with no text.
    .innerJoin(objects, eq(objects.apId, threadRoots.rootApId))
    .where(and(...conditions))
    // The other two counts as tiebreaks, so equal winners are ordered by how they won
    // rather than by insertion order.
    .orderBy(
      desc(primary),
      desc(threadRoots.externalNodeCount),
      desc(threadRoots.maxDepth),
      desc(objects.publishedAt),
    )
    .limit(opts.limit)

  return rows
}

export interface ThreadTreeRow {
  statusApId: string
  statusId: string
  origin: string
  url: string | null
  parentStatusApId: string | null
  depth: number
  publishedAt: Date | null
  handle: string
  isMine: boolean
}

export interface StoredThread {
  root: LeaderboardRow
  nodes: ThreadTreeRow[]
}

/**
 * One thread's stored shape, or null when it has never been walked.
 *
 * Addressed either by the canonical AP id or by `(origin, status_id)` — which is why
 * those two are columns rather than something re-parsed on demand. A bare numeric id has
 * no AP URL to synthesise (the username is unknown), and `get_thread_tree` advertises
 * bare ids the way `get_engagement` does, so the second form is the only way to honour it.
 */
export async function loadThread(
  ref: string | { origin: string; statusId: string },
  opts: { publicOnly?: boolean } = {},
): Promise<StoredThread | null> {
  const conditions = [
    typeof ref === 'string'
      ? eq(threadRoots.rootApId, ref)
      : and(eq(threadRoots.origin, ref.origin), eq(threadRoots.rootStatusId, ref.statusId))!,
  ]
  if (opts.publicOnly) conditions.push(eq(objects.visibility, 'public'))

  const [root] = await getDb()
    .select({
      rootApId: threadRoots.rootApId,
      actorApId: threadRoots.actorApId,
      url: objects.url,
      publishedAt: objects.publishedAt,
      nodeCount: threadRoots.nodeCount,
      externalNodeCount: threadRoots.externalNodeCount,
      maxDepth: threadRoots.maxDepth,
      externalParticipantCount: threadRoots.externalParticipantCount,
      newestNodeAt: threadRoots.newestNodeAt,
      walkedAt: threadRoots.walkedAt,
      text: objects.contentText,
    })
    .from(threadRoots)
    .innerJoin(objects, eq(objects.apId, threadRoots.rootApId))
    .where(and(...conditions))
    .limit(1)

  if (!root) return null

  const nodes = await getDb()
    .select({
      statusApId: threadNodes.statusApId,
      statusId: threadNodes.statusId,
      origin: threadNodes.origin,
      url: threadNodes.url,
      parentStatusApId: threadNodes.parentStatusApId,
      depth: threadNodes.depth,
      publishedAt: threadNodes.publishedAt,
      handle: threadNodes.handle,
      isMine: threadNodes.isMine,
    })
    .from(threadNodes)
    .where(eq(threadNodes.rootApId, root.rootApId))
    .orderBy(asc(threadNodes.depth), asc(threadNodes.publishedAt))

  return { root, nodes }
}

export interface FailingRoot {
  rootApId: string
  url: string | null
  walkedAt: Date | null
  walkAttempts: number
  walkError: string | null
}

/** Roots whose last walk failed. The "why is nothing here" table on /admin/threads. */
export async function loadWalkFailures(limit: number): Promise<FailingRoot[]> {
  return getDb()
    .select({
      rootApId: threadRoots.rootApId,
      url: objects.url,
      walkedAt: threadRoots.walkedAt,
      walkAttempts: threadRoots.walkAttempts,
      walkError: threadRoots.walkError,
    })
    .from(threadRoots)
    .leftJoin(objects, eq(objects.apId, threadRoots.rootApId))
    .where(isNotNull(threadRoots.walkError))
    .orderBy(desc(threadRoots.walkAttempts), desc(threadRoots.walkedAt))
    .limit(limit)
}

/** When the walker last wrote anything at all. */
export async function lastWalkAt(): Promise<Date | null> {
  // Ordered instead of aggregated: `max()` over a timestamptz comes back as a string
  // from postgres-js, and the tools serialise this alongside real Date columns.
  const [row] = await getDb()
    .select({ at: threadRoots.walkedAt })
    .from(threadRoots)
    .where(isNotNull(threadRoots.walkedAt))
    .orderBy(desc(threadRoots.walkedAt))
    .limit(1)
  return row?.at ?? null
}
