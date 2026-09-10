import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * What matters here is not the arithmetic — there isn't any — but which hosts an
 * unattended hourly job is willing to dial. The auto-watchlist is every accepted
 * follow, and a follow only says "he has an account here", never "this server is his".
 * Left ungated the sampler polled minreol.dk and bookwyrm.social twenty times an hour
 * apiece, forever, and an admin of one of them noticed before we did (record 0058).
 */

type FollowRow = { apId: string }

let followRows: FollowRow[] = []
let postsByActor = new Map<string, string[]>()
let sampleOrigins = new Set<string>()

// A drizzle-shaped thenable. The follows query is awaited after .where(); the per-actor
// posts query after .limit(). Both shapes resolve to whatever the fake was primed with.
function chain(result: unknown) {
  const o: Record<string, unknown> = {}
  const self = () => o
  o.from = self
  o.where = self
  o.orderBy = self
  o.limit = () => Promise.resolve(result)
  o.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej)
  return o
}

let selectCall = 0
const actorOrder: string[] = []

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: () => {
      // The first select of a run reads the follows; every later one reads one actor's
      // recent posts, in the order the job iterates them.
      if (selectCall++ === 0) return chain(followRows)
      const actor = actorOrder.shift() ?? ''
      return chain((postsByActor.get(actor) ?? []).map(apId => ({ apId })))
    },
  }),
}))

const getEngagement = vi.fn(async (input: { statuses: string[] }) => ({
  ok: input.statuses.length,
  failed: 0,
  results: input.statuses.map(() => ({ snapshot: 'written' as const })),
}))
vi.mock('../mcp/tools/engagement.js', () => ({ getEngagement }))

vi.mock('../config.js', async () => {
  const real = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...real,
    getEngagementSampleOrigins: () => sampleOrigins,
    config: {
      ...real.config,
      ENGAGEMENT_SAMPLE_RECENT_POSTS: 20,
      ENGAGEMENT_MAX_BATCH: 50,
    },
  }
})

const { sampleEngagement } = await import('./sample-engagement.js')

const OWN = 'https://skvip.lol/users/markus'
const THEIRS = 'https://minreol.dk/@markus@minreol.dk/'
const ALSO_THEIRS = 'https://bookwyrm.social/user/mvrkws'

function post(host: string, n: number) {
  return `https://${host}/posts/${n}`
}

/** Every status handed to getEngagement across all batches of one run. */
function dialled(): string[] {
  return getEngagement.mock.calls.flatMap(c => c[0].statuses)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectCall = 0
  actorOrder.length = 0
  followRows = []
  postsByActor = new Map()
  sampleOrigins = new Set(['skvip.lol'])
})

function prime(rows: Array<{ actor: string; posts: string[] }>) {
  followRows = rows.map(r => ({ apId: r.actor }))
  postsByActor = new Map(rows.map(r => [r.actor, r.posts]))
  actorOrder.push(...rows.map(r => r.actor))
}

describe('sampleEngagement origin gate', () => {
  it('polls a followed actor on a sampled origin', async () => {
    prime([{ actor: OWN, posts: [post('skvip.lol', 1), post('skvip.lol', 2)] }])
    await sampleEngagement()
    expect(dialled()).toEqual([post('skvip.lol', 1), post('skvip.lol', 2)])
  })

  it('never dials an origin outside the list, however many accounts he has there', async () => {
    prime([
      { actor: OWN, posts: [post('skvip.lol', 1)] },
      { actor: THEIRS, posts: [post('minreol.dk', 1), post('minreol.dk', 2)] },
      { actor: ALSO_THEIRS, posts: [post('bookwyrm.social', 1)] },
    ])
    await sampleEngagement()
    expect(dialled()).toEqual([post('skvip.lol', 1)])
  })

  // The actor filter is the cheap one; this is the one that holds. A post is fetched
  // from the post's own host, which is not guaranteed to be the host of the actor it
  // was filed under — so an excluded host must not ride in on an included actor.
  it('gates on the post host, not the actor host', async () => {
    prime([{ actor: OWN, posts: [post('skvip.lol', 1), post('minreol.dk', 9)] }])
    await sampleEngagement()
    expect(dialled()).toEqual([post('skvip.lol', 1)])
  })

  it('does nothing at all when no followed actor is on a sampled origin', async () => {
    prime([{ actor: THEIRS, posts: [post('minreol.dk', 1)] }])
    await sampleEngagement()
    expect(getEngagement).not.toHaveBeenCalled()
  })

  // Empty is "poll nothing", not "poll everything". An unconfigured deployment that
  // fell back to the whole watchlist is exactly the state this record exists to end.
  it('polls nothing when the list is empty', async () => {
    sampleOrigins = new Set()
    prime([{ actor: OWN, posts: [post('skvip.lol', 1)] }])
    await sampleEngagement()
    expect(getEngagement).not.toHaveBeenCalled()
  })
})
