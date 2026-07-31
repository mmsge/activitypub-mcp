import { describe, it, expect, vi, beforeEach } from 'vitest'

const countNotes = vi.fn(async () => 0)
vi.mock('./notes-store.js', () => ({
  countNotes,
  listNotes: vi.fn(),
  listPinnedNotes: vi.fn(),
  listNotesForProfile: vi.fn(),
  getNote: vi.fn(),
}))

const { nodeinfoRouter } = await import('./nodeinfo.js')

async function get(path: string) {
  const res = await nodeinfoRouter.request(path)
  return { res, body: await res.json() as any }
}

beforeEach(() => {
  countNotes.mockResolvedValue(0)
})

describe('nodeinfo discovery', () => {
  it('advertises both schema versions', async () => {
    const { res, body } = await get('/nodeinfo')
    expect(res.status).toBe(200)
    expect(body.links).toEqual([
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: 'https://test.local/nodeinfo/2.0',
      },
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: 'https://test.local/nodeinfo/2.1',
      },
    ])
  })

  it('is readable cross-origin, since the crawlers and instance pickers are browsers', async () => {
    const { res } = await get('/nodeinfo')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('nodeinfo documents', () => {
  for (const version of ['2.0', '2.1']) {
    describe(version, () => {
      it('carries every field the schema requires', async () => {
        const { res, body } = await get(`/nodeinfo/${version}`)
        expect(res.status).toBe(200)
        // Validators key off the profile parameter, not a bare application/json.
        expect(res.headers.get('content-type')).toContain(
          `profile="http://nodeinfo.diaspora.software/ns/schema/${version}#"`,
        )

        expect(body.version).toBe(version)
        expect(body.software.name).toBe('activitypub-mcp')
        expect(body.software.version).toBeTruthy()
        expect(body.protocols).toEqual(['activitypub'])
        // Required even when empty — this host bridges no third-party service.
        expect(body.services).toEqual({ inbound: [], outbound: [] })
        expect(body.openRegistrations).toBe(false)
        expect(body.usage.users).toEqual({ total: 1, activeMonth: 1, activeHalfyear: 1 })
        expect(body.metadata.nodeName).toBeTruthy()
        expect(body.metadata.nodeDescription).toBeTruthy()
      })

      it('reports the real number of published notes', async () => {
        countNotes.mockResolvedValue(7)
        const { body } = await get(`/nodeinfo/${version}`)
        expect(body.usage.localPosts).toBe(7)
      })

      it('answers 0 rather than 500 when the database is unreachable', async () => {
        // Crawlers hit this unauthenticated and often; an undercount beats looking dead.
        countNotes.mockRejectedValue(new Error('no database'))
        const { res, body } = await get(`/nodeinfo/${version}`)
        expect(res.status).toBe(200)
        expect(body.usage.localPosts).toBe(0)
      })
    })
  }

  it('keeps repository out of 2.0, whose schema rejects it, and in 2.1', async () => {
    expect((await get('/nodeinfo/2.0')).body.software.repository).toBeUndefined()
    expect((await get('/nodeinfo/2.1')).body.software.repository)
      .toBe('https://github.com/mmsge/activitypub-mcp')
  })
})
