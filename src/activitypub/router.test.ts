import { describe, it, expect, vi } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

const { activityPubRouter } = await import('./router.js')

/** GET through the router without binding a port. */
function get(path: string, headers: Record<string, string> = {}) {
  return activityPubRouter.request(path, { headers })
}

describe('GET /actor content negotiation', () => {
  it('serves the actor document when the client asks for activity+json', async () => {
    const res = await get('/actor', { accept: 'application/activity+json' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/activity+json')
    expect((await res.json() as any).type).toBe('Service')
  })

  it('serves the actor document when no Accept header is sent', async () => {
    const res = await get('/actor')
    expect(res.headers.get('content-type')).toContain('application/activity+json')
  })

  it('serves the actor document for a vague Accept: */*', async () => {
    // Several fediverse implementations send this and expect JSON. Defaulting to HTML
    // here would break federation, so this is the case that matters most.
    const res = await get('/actor', { accept: '*/*' })
    expect(res.headers.get('content-type')).toContain('application/activity+json')
  })

  it('serves the profile page to a browser', async () => {
    const res = await get('/actor', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Han arkiverer ingenting om deg')
  })

  it('keeps the Mastodon /users alias on JSON regardless of Accept', async () => {
    const res = await get('/users/bot', { accept: 'text/html' })
    expect(res.headers.get('content-type')).toContain('application/activity+json')
  })
})

describe('GET /@username', () => {
  it('always serves the profile page', async () => {
    const res = await get('/@bot', { accept: '*/*' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('@bot@test.local')
  })
})

describe('GET /assets/:image.png', () => {
  it('serves the avatar as a cacheable PNG', async () => {
    const res = await get('/assets/avatar.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]) // PNG magic
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
  })

  it('serves the header image too', async () => {
    const res = await get('/assets/header.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('answers 304 when the client already has the current bytes', async () => {
    const etag = (await get('/assets/avatar.png')).headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/)

    const res = await get('/assets/avatar.png', { 'if-none-match': etag })
    expect(res.status).toBe(304)
  })

  it('404s an unknown asset', async () => {
    expect((await get('/assets/nope.png')).status).toBe(404)
  })
})
