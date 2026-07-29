import { describe, it, expect, vi } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

const { webfingerRouter } = await import('./webfinger.js')

async function lookup(resource: string) {
  const res = await webfingerRouter.request(
    `/webfinger?resource=${encodeURIComponent(resource)}`,
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
})
