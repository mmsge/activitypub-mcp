import { describe, it, expect } from 'vitest'
import {
  buildThreadShape,
  handleFromActorApId,
  isSettled,
  normaliseHandle,
  splitApId,
  type ContextStatus,
  type RootNode,
} from './thread-context.js'

/**
 * What a conversation's shape is, and what it deliberately is not.
 *
 * The interesting cases here are all subtractive: a followers-only reply, a reply under
 * one, a host that is skipped, a status whose id cannot be read. Each of those must
 * disappear WITH its subtree rather than be flattened or half-kept, because a re-parented
 * grandchild would invent a conversation that never happened — and would leak how many
 * answers the hidden reply drew, which is the thing not storing it was meant to avoid.
 */

const ORIGIN = 'skvip.lol'
const MINE = new Set(['@markus@skvip.lol'])

const root: RootNode = {
  statusApId: 'https://skvip.lol/users/markus/statuses/100',
  statusId: '100',
  origin: ORIGIN,
  url: 'https://skvip.lol/@markus/100',
  publishedAt: new Date('2026-08-01T10:00:00Z'),
  handle: '@markus@skvip.lol',
}

let clock = Date.parse('2026-08-01T10:05:00Z')

/** One reply. `id`/`in_reply_to_id` are the QUERIED instance's local ids, which is the
 *  currency Mastodon quotes the link in; `uri` is the canonical identity. */
function reply(opts: {
  id: string
  parent: string
  acct: string
  visibility?: string
  host?: string
  uri?: string
}): ContextStatus {
  clock += 60_000
  const host = opts.host ?? (opts.acct.includes('@') ? opts.acct.split('@')[1] : ORIGIN)
  return {
    id: opts.id,
    uri: opts.uri ?? `https://${host}/users/${opts.acct.split('@')[0]}/statuses/${opts.id}`,
    url: `https://${host}/@${opts.acct.split('@')[0]}/${opts.id}`,
    in_reply_to_id: opts.parent,
    visibility: opts.visibility ?? 'public',
    created_at: new Date(clock).toISOString(),
    account: { acct: opts.acct },
    // Everything below is what the endpoint also sends and this module must never read.
    content: '<p>something someone actually wrote</p>',
    spoiler_text: 'cw',
    media_attachments: [{ url: 'https://example.invalid/x.png', description: 'alt text' }],
  } as ContextStatus
}

const build = (descendants: ContextStatus[], skipHosts = new Set<string>()) =>
  buildThreadShape({ root, descendants, queriedOrigin: ORIGIN, mine: MINE, skipHosts })

describe('buildThreadShape', () => {
  it('stores the root as node 0 and measures depth in hops from it', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'someone@mastodon.social' }),
      reply({ id: '202', parent: '201', acct: 'markus' }),
      reply({ id: '203', parent: '202', acct: 'someone@mastodon.social' }),
      reply({ id: '204', parent: '100', acct: 'another@chaos.social' }),
    ])

    expect(shape.nodes[0]).toMatchObject({
      statusApId: root.statusApId,
      depth: 0,
      isMine: true,
      parentStatusApId: null,
    })
    expect(shape.stats.nodeCount).toBe(5)
    expect(shape.stats.maxDepth).toBe(3)
  })

  it('excludes his own nodes — the root included — from every external figure', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'someone@mastodon.social' }),
      reply({ id: '202', parent: '201', acct: 'markus' }),
      reply({ id: '203', parent: '202', acct: 'someone@mastodon.social' }),
      reply({ id: '204', parent: '100', acct: 'another@chaos.social' }),
    ])

    expect(shape.stats.nodeCount).toBe(5)
    // Five nodes, three of them somebody else's; two distinct external people.
    expect(shape.stats.externalNodeCount).toBe(3)
    expect(shape.stats.externalParticipantCount).toBe(2)
  })

  it('scores a thread of only his own replies at zero, so it never reaches the leaderboard', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'markus' }),
      reply({ id: '202', parent: '201', acct: 'markus' }),
    ])

    expect(shape.stats.nodeCount).toBe(3)
    expect(shape.stats.externalNodeCount).toBe(0)
    expect(shape.stats.externalParticipantCount).toBe(0)
  })

  it('drops a followers-only reply AND everything under it, rather than re-parenting', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'private@mastodon.social', visibility: 'private' }),
      reply({ id: '202', parent: '201', acct: 'someone@chaos.social' }),
      reply({ id: '203', parent: '202', acct: 'third@chaos.social' }),
      reply({ id: '204', parent: '100', acct: 'public@chaos.social' }),
    ])

    // Only the root and the one public sibling survive. Promoting 202 to depth 1 would
    // both invent an exchange and disclose that the hidden reply drew two answers.
    expect(shape.nodes.map(n => n.statusId)).toEqual(['100', '204'])
    expect(shape.dropped.visibility).toBe(1)
    expect(shape.dropped.orphaned).toBe(2)
    expect(shape.stats.externalNodeCount).toBe(1)
  })

  it('drops a direct reply too', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'dm@mastodon.social', visibility: 'direct' }),
    ])
    expect(shape.nodes).toHaveLength(1)
    expect(shape.dropped.visibility).toBe(1)
  })

  it('keeps unlisted replies, which are walkable', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'quiet@chaos.social', visibility: 'unlisted' }),
    ])
    expect(shape.stats.externalNodeCount).toBe(1)
  })

  it('drops a reply from a skipped host, and its subtree with it', () => {
    const shape = build(
      [
        reply({ id: '201', parent: '100', acct: 'someone@bad.example' }),
        reply({ id: '202', parent: '201', acct: 'other@chaos.social' }),
        reply({ id: '203', parent: '100', acct: 'fine@chaos.social' }),
      ],
      new Set(['bad.example']),
    )

    expect(shape.nodes.map(n => n.statusId)).toEqual(['100', '203'])
    expect(shape.dropped.skippedHost).toBe(1)
    expect(shape.dropped.orphaned).toBe(1)
  })

  it('keys a node on its own origin, not on the instance that was asked', () => {
    const shape = build([reply({ id: '201', parent: '100', acct: 'someone@mastodon.social' })])
    const node = shape.nodes[1]!
    expect(node.origin).toBe('mastodon.social')
    expect(node.statusId).toBe('201')
    expect(node.handle).toBe('@someone@mastodon.social')
  })

  it('drops a status whose identity cannot be read, rather than fabricating one', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'weird@chaos.social', uri: 'not a url' }),
      reply({ id: '202', parent: '201', acct: 'downstream@chaos.social' }),
    ])
    expect(shape.nodes).toHaveLength(1)
    expect(shape.dropped.unparseable).toBe(1)
    expect(shape.dropped.orphaned).toBe(1)
  })

  it('carries through ids, permalinks, handles and times — and nothing else', () => {
    const shape = build([reply({ id: '201', parent: '100', acct: 'someone@mastodon.social' })])
    // The fixture's statuses carry content, a content warning and an attachment with alt
    // text. If any of it ever appears on a node, this is where it shows up.
    expect(Object.keys(shape.nodes[1]!).sort()).toEqual([
      'depth', 'handle', 'isMine', 'origin', 'parentStatusApId',
      'publishedAt', 'statusApId', 'statusId', 'url',
    ])
    expect(JSON.stringify(shape)).not.toContain('something someone actually wrote')
    expect(JSON.stringify(shape)).not.toContain('alt text')
    expect(JSON.stringify(shape)).not.toContain('cw')
  })

  it('takes the newest node as the tree\'s timestamp', () => {
    const shape = build([
      reply({ id: '201', parent: '100', acct: 'someone@chaos.social' }),
      reply({ id: '202', parent: '201', acct: 'someone@chaos.social' }),
    ])
    expect(shape.stats.newestNodeAt).toEqual(shape.nodes[2]!.publishedAt)
  })

  it('falls back to the root\'s own timestamp when nothing replied', () => {
    // Without this a fresh toot would read as settled during exactly the week its
    // replies arrive, and the daily pass would never look at it again.
    const shape = build([])
    expect(shape.stats.newestNodeAt).toEqual(root.publishedAt)
    expect(shape.stats.nodeCount).toBe(1)
  })

  it('survives a cycle in the payload without hanging', () => {
    const shape = build([
      reply({ id: '201', parent: '202', acct: 'a@chaos.social' }),
      reply({ id: '202', parent: '201', acct: 'b@chaos.social' }),
    ])
    // Neither is reachable from the root, so both are orphans.
    expect(shape.nodes).toHaveLength(1)
    expect(shape.dropped.orphaned).toBe(2)
  })
})

describe('normaliseHandle', () => {
  it('completes a bare acct with the instance that was asked', () => {
    expect(normaliseHandle('markus', 'skvip.lol')).toBe('@markus@skvip.lol')
  })

  it('keeps a remote acct as given, lowercasing the host', () => {
    expect(normaliseHandle('someone@Mastodon.Social', 'skvip.lol')).toBe('@someone@mastodon.social')
  })

  it('refuses anything that is not a handle', () => {
    expect(normaliseHandle('Markus Andersen', 'skvip.lol')).toBeNull()
    expect(normaliseHandle('', 'skvip.lol')).toBeNull()
    expect(normaliseHandle(undefined, 'skvip.lol')).toBeNull()
  })
})

describe('splitApId', () => {
  it('reads the origin off the id\'s own host and the local id off its last segment', () => {
    expect(splitApId('https://mastodon.social/users/x/statuses/1234')).toEqual({
      origin: 'mastodon.social',
      statusId: '1234',
    })
    expect(splitApId('https://akkoma.example/objects/1f2e3d4c-aaaa-bbbb')).toEqual({
      origin: 'akkoma.example',
      statusId: '1f2e3d4c-aaaa-bbbb',
    })
  })

  it('refuses an id whose last segment would fail the schema\'s CHECK', () => {
    expect(splitApId('https://example.invalid/a%20b')).toBeNull()
  })
})

describe('handleFromActorApId', () => {
  it('derives the owner\'s handle from the actor id when the stored row has none', () => {
    expect(handleFromActorApId('https://skvip.lol/users/markus')).toBe('@markus@skvip.lol')
  })

  it('returns null rather than a guess', () => {
    expect(handleFromActorApId('nonsense')).toBeNull()
  })
})

describe('isSettled', () => {
  const now = Date.parse('2026-08-28T12:00:00Z')
  const daysAgo = (n: number) => new Date(now - n * 86_400_000)

  it('is false while the newest node is inside the window, so the daily pass re-walks it', () => {
    expect(isSettled(daysAgo(6), 7, now)).toBe(false)
    expect(isSettled(daysAgo(0), 7, now)).toBe(false)
  })

  it('is true from the boundary onwards, so a daily job is not a nightly backfill', () => {
    expect(isSettled(daysAgo(7), 7, now)).toBe(true)
    expect(isSettled(daysAgo(400), 7, now)).toBe(true)
  })

  it('is false when nothing is known — an unwalked root must be walked before it is judged', () => {
    expect(isSettled(null, 7, now)).toBe(false)
  })
})
