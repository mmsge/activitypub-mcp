import { describe, it, expect, vi, beforeEach } from 'vitest'

// An archive actor has no server. Every path through the actor lookup that could dial
// one — WebFinger, the actor document, the 24h refresh — must stay inside our own table,
// so the stubbed network throws on any use and the stubbed table answers from a queue.

const answers: unknown[][] = []
const chain = (): Record<string, unknown> => {
  const link: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit', 'orderBy']) link[m] = () => link
  link.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answers.shift() ?? []).then(resolve)
  return link
}
vi.mock('../db/client.js', () => ({ getDb: () => ({ select: () => chain() }) }))

const net = vi.fn(() => {
  throw new Error('an archive actor must never be fetched over the network')
})
vi.stubGlobal('fetch', net)

const { fetchActor, resolveActorByHandle } = await import('./fetch-actor.js')

const longAgo = new Date('2020-01-01T00:00:00Z')
const stored = {
  apId: 'https://twitter.com/MThorr',
  handle: '@MThorr@twitter.com',
  username: 'MThorr',
  domain: 'twitter.com',
  software: 'twitter',
  displayName: 'Markus Þórr',
  summary: null,
  iconUrl: null,
  publicKeyPem: '',
  inboxUrl: '',
  sharedInboxUrl: null,
  followersUrl: null,
  followingUrl: null,
  raw: {},
  fetchedAt: longAgo,
  createdAt: longAgo,
  updatedAt: longAgo,
}

beforeEach(() => {
  answers.length = 0
  net.mockClear()
})

describe('resolveActorByHandle for an archive domain', () => {
  it('answers from the table, never over the network', async () => {
    answers.push([stored])
    const actor = await resolveActorByHandle('@mthorr@twitter.com')
    expect(actor?.apId).toBe('https://twitter.com/MThorr')
    expect(actor?.handle).toBe('@MThorr@twitter.com')
    expect(net).not.toHaveBeenCalled()
  })

  it('is null for an account that was never imported, again without a request', async () => {
    answers.push([])
    expect(await resolveActorByHandle('@nobody@twitter.com')).toBeNull()
    expect(net).not.toHaveBeenCalled()
  })
})

describe('fetchActor for an archive URL', () => {
  it('returns the stored actor at any age instead of refreshing it', async () => {
    answers.push([stored])
    const actor = await fetchActor('https://twitter.com/MThorr')
    expect(actor.displayName).toBe('Markus Þórr')
    expect(net).not.toHaveBeenCalled()
  })

  it('says it was never imported rather than dialling twitter.com', async () => {
    answers.push([])
    await expect(fetchActor('https://twitter.com/stranger')).rejects.toThrow(/has not been imported/)
    expect(net).not.toHaveBeenCalled()
  })
})
