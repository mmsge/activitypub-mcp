import { describe, it, expect, vi } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

const { webfingerRouter } = await import('./webfinger.js')

async function lookup(resource: string, query = '') {
  const res = await webfingerRouter.request(
    `/webfinger?resource=${encodeURIComponent(resource)}${query}`,
  )
  return { res, body: await res.json() as any }
}

describe('webfinger', () => {
  it('resolves the bot to its actor document, profile page and avatar', async () => {
    const { res, body } = await lookup('acct:bot@test.local')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/jrd+json')
    expect(body.subject).toBe('acct:bot@test.local')

    const byRel = Object.fromEntries(body.links.map((l: any) => [l.rel, l]))

    expect(byRel['self']).toMatchObject({
      type: 'application/activity+json',
      href: 'https://test.local/actor',
    })

    // The profile-page link must be the HTML page, not the actor URL: /actor only
    // returns HTML to clients that explicitly ask for it.
    expect(byRel['http://webfinger.net/rel/profile-page']).toMatchObject({
      type: 'text/html',
      href: 'https://test.local/@bot',
    })

    expect(byRel['http://webfinger.net/rel/avatar'].type).toBe('image/png')
    expect(byRel['http://webfinger.net/rel/avatar'].href).toContain('/assets/avatar.png')
  })

  it('lists both the actor and the profile page as aliases', async () => {
    const { body } = await lookup('acct:bot@test.local')
    expect(body.aliases).toEqual(['https://test.local/actor', 'https://test.local/@bot'])
  })

  it('404s any other account', async () => {
    const { res } = await lookup('acct:someone@elsewhere.example')
    expect(res.status).toBe(404)
  })

  it('400s a request with no resource', async () => {
    expect((await webfingerRouter.request('/webfinger')).status).toBe(400)
  })

  it('is readable by browser-side clients', async () => {
    const { res } = await lookup('acct:bot@test.local')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('webfinger resource spellings', () => {
  // Only the acct: form is required of us, but implementations ask with the bare handle
  // or with one of the actor's URLs, and answering 404 to those reads as "no such
  // account" rather than "wrong spelling".
  const accepted = [
    'acct:bot@test.local',
    'bot@test.local',
    'https://test.local/actor',
    'https://test.local/@bot',
    'https://test.local/users/bot',
    'ACCT:Bot@TEST.local',
    'https://test.local/actor/',
  ]

  for (const resource of accepted) {
    it(`resolves ${resource}`, async () => {
      const { res, body } = await lookup(resource)
      expect(res.status).toBe(200)
      // Always the canonical acct: form, whichever spelling arrived — implementations
      // that re-finger the subject they get back would otherwise loop through a URL.
      expect(body.subject).toBe('acct:bot@test.local')
    })
  }

  it('still refuses a resource on another host', async () => {
    expect((await lookup('https://elsewhere.example/actor')).res.status).toBe(404)
    expect((await lookup('acct:bot@elsewhere.example')).res.status).toBe(404)
  })
})

describe('webfinger rel filtering', () => {
  it('narrows the links to the rels asked for', async () => {
    const { body } = await lookup('acct:bot@test.local', '&rel=self')
    expect(body.links).toHaveLength(1)
    expect(body.links[0].rel).toBe('self')
  })

  it('honours a repeated rel parameter', async () => {
    const { body } = await lookup(
      'acct:bot@test.local',
      '&rel=self&rel=http%3A%2F%2Fwebfinger.net%2Frel%2Favatar',
    )
    expect(body.links.map((l: any) => l.rel)).toEqual([
      'self',
      'http://webfinger.net/rel/avatar',
    ])
  })

  it('answers an unmatched rel with no links rather than a 404 — the subject exists', async () => {
    const { res, body } = await lookup('acct:bot@test.local', '&rel=nonsense')
    expect(res.status).toBe(200)
    expect(body.subject).toBe('acct:bot@test.local')
    expect(body.links).toEqual([])
  })
})
