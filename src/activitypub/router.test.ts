import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

const NOTE = {
  id: '11111111-2222-4333-8444-555555555555',
  kind: 'intro',
  content: '<p>Dette er ein personleg ActivityPub-bot.</p>',
  contentText: 'Dette er ein personleg ActivityPub-bot.',
  digest: 'deadbeefdeadbeef',
  pinned: true,
  publishedAt: new Date('2026-05-02T10:00:00.000Z'),
  updatedAt: new Date('2026-05-02T10:00:00.000Z'),
}

// The router's note reads all go through this module; mocking it keeps the suite off a
// database while still exercising the real documents built from a row.
const listNotesForProfile = vi.fn(async () => [] as typeof NOTE[])
const listPinnedNotes = vi.fn(async () => [] as typeof NOTE[])
const getNote = vi.fn(async (_id: string): Promise<typeof NOTE | null> => null)
const listNotes = vi.fn(async () => [] as typeof NOTE[])
const countNotes = vi.fn(async () => 0)

vi.mock('./notes-store.js', () => ({
  listNotesForProfile, listPinnedNotes, getNote, listNotes, countNotes,
}))

const { activityPubRouter } = await import('./router.js')

/** GET through the router without binding a port. */
function get(path: string, headers: Record<string, string> = {}) {
  return activityPubRouter.request(path, { headers })
}

beforeEach(() => {
  listNotesForProfile.mockResolvedValue([])
  listPinnedNotes.mockResolvedValue([])
  getNote.mockResolvedValue(null)
  listNotes.mockResolvedValue([])
  countNotes.mockResolvedValue(0)
})

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

  it('tells caches the two representations are not interchangeable', async () => {
    // Without Vary a shared cache is free to hand a fediverse server the page a browser
    // asked for a moment earlier, and the account stops resolving.
    for (const accept of ['application/activity+json', 'text/html']) {
      expect((await get('/actor', { accept })).headers.get('vary')).toBe('Accept')
    }
    for (const accept of ['application/activity+json', 'text/html']) {
      expect((await get('/@bot', { accept })).headers.get('vary')).toBe('Accept')
    }
  })
})

describe('GET /@username', () => {
  it('serves the profile page to browsers and vague clients', async () => {
    for (const accept of ['*/*', 'text/html,application/xhtml+xml,*/*;q=0.8']) {
      const res = await get('/@bot', { accept })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('@bot@test.local')
    }
  })

  it('serves the profile page when no Accept header is sent', async () => {
    const res = await get('/@bot')
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('answers the actor document to an ActivityPub resolver', async () => {
    // Mastodon's URL search fetches the page URL with exactly this Accept header. If it
    // cannot reach the actor from here it reports "no results", so the account becomes
    // unfindable by link — which is what happened before this case was handled.
    const res = await get('/@bot', {
      accept: 'application/activity+json, application/ld+json',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/activity+json')
    expect((await res.json() as any).id).toBe('https://test.local/actor')
  })

  it('still prefers HTML when a client asks for both', async () => {
    const res = await get('/@bot', { accept: 'text/html, application/activity+json' })
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('links the ActivityPub representation for clients that only parse HTML', async () => {
    const html = await (await get('/@bot', { accept: 'text/html' })).text()
    expect(html).toContain(
      '<link rel="alternate" type="application/activity+json" href="https://test.local/actor">',
    )
  })
})

describe('GET /actor/featured', () => {
  it('is an empty collection until something is pinned', async () => {
    const res = await get('/actor/featured')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/activity+json')
    expect(await res.json()).toMatchObject({
      id: 'https://test.local/actor/featured',
      type: 'OrderedCollection',
      totalItems: 0,
      orderedItems: [],
    })
  })

  it('embeds the pinned note rather than listing its URI', async () => {
    // Mastodon refetches this on every profile refresh; embedding saves it one fetch
    // per pinned note, and is what puts a readable post on an otherwise bare profile.
    listPinnedNotes.mockResolvedValue([NOTE])
    const body = await (await get('/actor/featured')).json() as any

    expect(body.totalItems).toBe(1)
    expect(body.orderedItems[0]).toMatchObject({
      id: `https://test.local/notes/${NOTE.id}`,
      type: 'Note',
      attributedTo: 'https://test.local/actor',
      content: NOTE.content,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    })
  })
})

describe('GET /notes/:id', () => {
  it('404s an unknown note', async () => {
    expect((await get('/notes/11111111-2222-4333-8444-999999999999')).status).toBe(404)
    // A non-UUID never reaches Postgres as a failed cast.
    expect((await get('/notes/not-a-uuid')).status).toBe(404)
  })

  it('defaults to the ActivityPub object, because this URL is the note id', async () => {
    // A server dereferencing the id may send nothing more specific than Accept: */*;
    // handing it HTML would fail ingestion.
    getNote.mockResolvedValue(NOTE)
    const cases: Record<string, string>[] = [{}, { accept: '*/*' }, { accept: 'application/activity+json' }]
    for (const headers of cases) {
      const res = await get(`/notes/${NOTE.id}`, headers)
      expect(res.headers.get('content-type')).toContain('application/activity+json')
      const body = await res.json() as any
      expect(body['@context']).toBe('https://www.w3.org/ns/activitystreams')
      expect(body.id).toBe(`https://test.local/notes/${NOTE.id}`)
      expect(body.url).toBe(body.id)
    }
  })

  it('serves a readable page to a browser', async () => {
    getNote.mockResolvedValue(NOTE)
    const res = await get(`/notes/${NOTE.id}`, { accept: 'text/html' })
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('vary')).toBe('Accept')

    const html = await res.text()
    expect(html).toContain('Dette er ein personleg ActivityPub-bot.')
    expect(html).toContain(`<link rel="canonical" href="https://test.local/notes/${NOTE.id}">`)
  })
})

describe('collection aliases under /users/<name>', () => {
  // Only the inbox had an alias before, so anything composing collection URLs from the
  // /users form — rather than reading them off the actor document — hit a 404 and
  // concluded the account had nothing.
  it('answers followers, featured and the outbox under both prefixes', async () => {
    for (const path of ['/followers', '/featured', '/outbox']) {
      const canonical = await get(`/actor${path}`)
      const alias = await get(`/users/bot${path}`)
      expect(canonical.status).toBe(200)
      expect(alias.status).toBe(200)
      // The alias answers with the canonical ids, so nothing ends up with two identities.
      expect(await alias.json()).toEqual(await canonical.json())
    }
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

describe('robots.txt and sitemap.xml', () => {
  // The box convention asks every service to serve both; this one never has.
  it('allows crawling the public pages', async () => {
    const res = await get('/robots.txt')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Allow: /')
    expect(body).toContain('Sitemap: https://')
  })

  it('keeps crawlers off the surfaces that are not content', async () => {
    const body = await (await get('/robots.txt')).text()
    for (const path of ['/admin', '/api/', '/mcp', '/oauth', '/healthz', '/version', '/health']) {
      expect(body, path).toContain(`Disallow: ${path}`)
    }
  })

  it('lists the profile and the actor in the sitemap', async () => {
    listNotesForProfile.mockResolvedValueOnce([])
    const res = await get('/sitemap.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xml')
    const body = await res.text()
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(body).toContain('/@bot')
    expect(body).toContain('/actor')
  })

  it('lists each published note with its own lastmod', async () => {
    listNotesForProfile.mockResolvedValueOnce([NOTE])
    const body = await (await get('/sitemap.xml')).text()
    expect(body).toContain(`/notes/${NOTE.id}`)
    expect(body).toContain('<lastmod>2026-05-02T10:00:00.000Z</lastmod>')
  })

  it('still serves a sitemap when the notes query fails', async () => {
    // A database hiccup must not turn a crawler hint into a 500.
    listNotesForProfile.mockRejectedValueOnce(new Error('no database'))
    const res = await get('/sitemap.xml')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('/actor')
  })
})
