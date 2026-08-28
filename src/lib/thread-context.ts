/**
 * The shape of a conversation, derived from one Mastodon context response.
 *
 * Pure: no database, no network, no clock. Everything that decides what a tree looks
 * like — which replies count, who the participants are, how deep it goes — is settled
 * here so it can be asserted without either.
 *
 * **What this deliberately does not carry through.** The context payload is full
 * statuses: content, spoiler text, attachments, alt text, display names, avatars,
 * favourite counts. None of it is read. A node is an id, a permalink, a parent link, a
 * depth, a timestamp, a handle and a flag, and the schema's CHECK constraints make that
 * true of the storage as well as of this function. See decision record 0057.
 */

/** The subset of a Mastodon status this module reads. Everything else is ignored, which
 *  is the privacy claim expressed as a type. */
export interface ContextStatus {
  /** The QUERIED instance's local id — the currency `in_reply_to_id` is quoted in. */
  id?: unknown
  /** The canonical AP id. The node's real identity, and the origin we key on. */
  uri?: unknown
  url?: unknown
  in_reply_to_id?: unknown
  visibility?: unknown
  created_at?: unknown
  account?: { acct?: unknown } | unknown
}

export interface ThreadNode {
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

export interface ThreadStats {
  /** Includes the root. */
  nodeCount: number
  externalNodeCount: number
  maxDepth: number
  externalParticipantCount: number
  /** Never null: falls back to the root's own timestamp when the tree has no replies. */
  newestNodeAt: Date | null
}

export interface ThreadShape {
  nodes: ThreadNode[]
  stats: ThreadStats
  /** Replies the walk refused to keep, and why. Reported so a thread that renders
   *  smaller than it looks on the web is explainable rather than merely wrong. */
  dropped: { visibility: number; skippedHost: number; unparseable: number; orphaned: number }
}

/** The two visibilities that may be walked. Followers-only and direct replies are
 *  skipped entirely — not stored as redacted nodes, not counted, not hinted at. */
const WALKABLE = new Set(['public', 'unlisted'])

/** Mirrors the `thread_nodes` CHECK constraints. A value that fails here would be
 *  rejected by the database, so it is dropped in the open rather than at INSERT time. */
const STATUS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const HOST_RE = /^[a-z0-9.-]{1,253}$/
const HANDLE_RE = /^@[^@\s]{1,64}@[a-z0-9.-]{1,253}$/
const AP_ID_RE = /^https?:\/\/\S+$/

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** The canonical AP id with query and fragment stripped, or null when it isn't one. */
export function normaliseApId(raw: unknown): string | null {
  const v = str(raw)
  if (!v) return null
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const clean = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return clean.length <= 500 && AP_ID_RE.test(clean) ? clean : null
}

/** Origin host and origin-local id, read off the AP id's own host and last path segment
 *  — the same rule `parseStatusRef` uses in fetch-engagement.ts, and for the same reason:
 *  a status's id belongs to the host that minted it. */
export function splitApId(apId: string): { origin: string; statusId: string } | null {
  let url: URL
  try {
    url = new URL(apId)
  } catch {
    return null
  }
  const origin = url.hostname.toLowerCase()
  const statusId = url.pathname.split('/').filter(Boolean).pop() ?? ''
  if (!HOST_RE.test(origin) || !STATUS_ID_RE.test(statusId)) return null
  return { origin, statusId }
}

/**
 * `acct` → `@user@host`. Mastodon gives a bare username for accounts local to the
 * instance being asked, so the queried origin supplies the missing half. Null when the
 * result would not be a handle — never a display name, never a guess.
 */
export function normaliseHandle(acct: unknown, queriedOrigin: string): string | null {
  const v = str(acct)?.replace(/^@/, '')
  if (!v) return null
  const [user, host] = v.includes('@') ? v.split('@') : [v, queriedOrigin]
  if (!user || !host) return null
  const handle = `@${user}@${host.toLowerCase()}`
  return HANDLE_RE.test(handle) ? handle : null
}

/**
 * `https://skvip.lol/users/markus` → `@markus@skvip.lol`. The fallback for a root whose
 * stored `actors` row carries no handle — derived from the identifier itself rather than
 * fetched, because the walker must not need a profile lookup to name its own author.
 */
export function handleFromActorApId(apId: string): string | null {
  let url: URL
  try {
    url = new URL(apId)
  } catch {
    return null
  }
  const username = url.pathname.split('/').filter(Boolean).pop()?.replace(/^@/, '')
  if (!username) return null
  const handle = `@${username}@${url.hostname.toLowerCase()}`
  return HANDLE_RE.test(handle) ? handle : null
}

function parseDate(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Has this thread stopped moving?
 *
 * A settled thread is skipped by the daily incremental pass — the only reason a daily job
 * is not a nightly repeat of the backfill — and it is the flag the tools and the admin
 * page report. `loadRootsToWalk` mirrors this rule in SQL for the queue itself; this is
 * the assertable copy, the way `classifyVisibility` mirrors the generated column.
 *
 * A thread whose newest node is unknown is NOT settled: a root that has never been walked
 * has to be walked before anything can be said about it.
 */
export function isSettled(
  newestNodeAt: Date | null,
  settledDays: number,
  now: number = Date.now(),
): boolean {
  if (newestNodeAt === null) return false
  return now - newestNodeAt.getTime() >= settledDays * 86_400_000
}

export interface RootNode {
  statusApId: string
  statusId: string
  origin: string
  url: string | null
  publishedAt: Date | null
  handle: string
}

export interface BuildInput {
  root: RootNode
  descendants: ContextStatus[]
  /** The instance the context was read from. Only used to complete a bare `acct`. */
  queriedOrigin: string
  /** The owner's own handles, lowercase `@user@host`. */
  mine: Set<string>
  skipHosts: Set<string>
}

/**
 * Build the tree.
 *
 * Two rules here are load-bearing and both look like they could be relaxed:
 *
 *   **The root is a node, at depth 0.** So the tree is renderable from one query and an
 *   edge list needs no synthetic vertex. Every `external_*` figure excludes it, which is
 *   what makes a thread of only his own replies score zero rather than one.
 *
 *   **An orphan takes its subtree with it.** A reply under a followers-only reply is
 *   dropped, not promoted to depth 1. Re-parenting would invent a conversation that
 *   never happened, and it would leak the shape of the hidden reply — how many answers
 *   it drew — which is the thing not storing it was meant to avoid.
 */
export function buildThreadShape(input: BuildInput): ThreadShape {
  const { root, descendants, queriedOrigin, mine, skipHosts } = input
  const dropped = { visibility: 0, skippedHost: 0, unparseable: 0, orphaned: 0 }

  // Keyed by the QUERIED instance's local id, because that is the currency
  // `in_reply_to_id` is quoted in. The AP id is the identity; this is the link.
  const kept = new Map<string, { localParentId: string; node: Omit<ThreadNode, 'depth'> }>()

  for (const s of descendants) {
    const visibility = str(s.visibility)
    if (!visibility || !WALKABLE.has(visibility)) {
      dropped.visibility += 1
      continue
    }

    const localId = str(s.id)
    const localParentId = str(s.in_reply_to_id)
    const statusApId = normaliseApId(s.uri)
    const parts = statusApId ? splitApId(statusApId) : null
    const account = (s.account ?? null) as { acct?: unknown } | null
    const handle = normaliseHandle(account?.acct, queriedOrigin)

    if (!localId || !localParentId || !statusApId || !parts || !handle) {
      dropped.unparseable += 1
      continue
    }
    if (skipHosts.has(parts.origin)) {
      dropped.skippedHost += 1
      continue
    }

    kept.set(localId, {
      localParentId,
      node: {
        statusApId,
        statusId: parts.statusId,
        origin: parts.origin,
        url: normaliseApId(s.url),
        parentStatusApId: null, // filled in during the walk, when the parent is known
        publishedAt: parseDate(s.created_at),
        handle,
        isMine: mine.has(handle.toLowerCase()),
      },
    })
  }

  const children = new Map<string, string[]>()
  for (const [localId, entry] of kept) {
    const siblings = children.get(entry.localParentId)
    if (siblings) siblings.push(localId)
    else children.set(entry.localParentId, [localId])
  }

  const nodes: ThreadNode[] = [{
    statusApId: root.statusApId,
    statusId: root.statusId,
    origin: root.origin,
    url: root.url,
    parentStatusApId: null,
    depth: 0,
    publishedAt: root.publishedAt,
    handle: root.handle,
    isMine: true,
  }]

  // Breadth-first from the root's own local id. Anything not reached is an orphan (its
  // parent was dropped, or the payload contained a cycle) and stays dropped.
  const queue: Array<{ localId: string; parentApId: string; depth: number }> = (
    children.get(root.statusId) ?? []
  ).map(localId => ({ localId, parentApId: root.statusApId, depth: 1 }))
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { localId, parentApId, depth } = queue.shift()!
    if (seen.has(localId)) continue
    seen.add(localId)

    const entry = kept.get(localId)
    if (!entry) continue
    nodes.push({ ...entry.node, parentStatusApId: parentApId, depth })

    for (const child of children.get(localId) ?? []) {
      queue.push({ localId: child, parentApId: entry.node.statusApId, depth: depth + 1 })
    }
  }

  dropped.orphaned = kept.size - seen.size

  const external = nodes.filter(n => !n.isMine)
  const newest = nodes
    .map(n => n.publishedAt)
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null)

  return {
    nodes,
    stats: {
      nodeCount: nodes.length,
      externalNodeCount: external.length,
      maxDepth: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
      externalParticipantCount: new Set(external.map(n => n.handle.toLowerCase())).size,
      // The fallback is the whole point: with no replies the newest node IS the root, and
      // a null here would read as settled during exactly the week the replies arrive.
      newestNodeAt: newest ?? root.publishedAt,
    },
    dropped,
  }
}
