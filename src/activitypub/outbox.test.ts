import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

function note(n: number) {
  return {
    id: `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`,
    kind: 'status',
    content: `<p>Statusmelding ${n}.</p>`,
    contentText: `Statusmelding ${n}.`,
    digest: `digest${n}`,
    pinned: false,
    publishedAt: new Date(`2026-05-${String(n).padStart(2, '0')}T10:00:00.000Z`),
    updatedAt: new Date(`2026-05-${String(n).padStart(2, '0')}T10:00:00.000Z`),
  }
}

const listNotes = vi.fn(async (_limit: number, _offset?: number) => [] as ReturnType<typeof note>[])
const countNotes = vi.fn(async () => 0)

vi.mock('./notes-store.js', () => ({
  listNotes,
  countNotes,
  listPinnedNotes: vi.fn(),
  listNotesForProfile: vi.fn(),
  getNote: vi.fn(),
}))

// The outbox must reach the database only through the notes store. Anything else — a
// query against `activities`, say — trips this.
const getDb = vi.fn(() => {
  throw new Error('the outbox must not query the database directly')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { outboxRouter } = await import('./outbox.js')

const get = (path: string) => outboxRouter.request(path)

beforeEach(() => {
  listNotes.mockResolvedValue([])
  countNotes.mockResolvedValue(0)
})

describe('GET /actor/outbox', () => {
  it('is the collection itself, not a page of it', async () => {
    // Mastodon and the fediverse crawlers read totalItems from this URL and only follow
    // `first` if they want the contents. Answering with a bare OrderedCollectionPage —
    // as this endpoint used to — left them with no item count at all.
    countNotes.mockResolvedValue(42)
    const res = await get('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/activity+json')
    expect(await res.json()).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://test.local/actor/outbox',
      type: 'OrderedCollection',
      totalItems: 42,
      first: 'https://test.local/actor/outbox?page=1',
      last: 'https://test.local/actor/outbox?page=3',
    })
  })

  it('keeps a first and last page even when nothing has been published', async () => {
    const body = await (await get('/')).json() as any
    expect(body.totalItems).toBe(0)
    expect(body.first).toBe('https://test.local/actor/outbox?page=1')
    expect(body.last).toBe('https://test.local/actor/outbox?page=1')
  })

  it('wraps each note in a public Create on a page', async () => {
    countNotes.mockResolvedValue(1)
    listNotes.mockResolvedValue([note(2)])
    const body = await (await get('/?page=1')).json() as any

    expect(body.type).toBe('OrderedCollectionPage')
    expect(body.partOf).toBe('https://test.local/actor/outbox')
    expect(body.id).toBe('https://test.local/actor/outbox?page=1')
    expect(body.totalItems).toBe(1)

    const [create] = body.orderedItems
    expect(create).toMatchObject({
      type: 'Create',
      actor: 'https://test.local/actor',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: ['https://test.local/actor/followers'],
    })
    // The Create must not reuse the note's own id: implementations that key activities
    // and objects in one table silently drop one of the two when they collide.
    expect(create.id).not.toBe(create.object.id)
    expect(create.object).toMatchObject({
      type: 'Note',
      attributedTo: 'https://test.local/actor',
      content: '<p>Statusmelding 2.</p>',
    })
  })

  it('links next only while there is more, and prev only past the first page', async () => {
    countNotes.mockResolvedValue(45)
    listNotes.mockResolvedValue([note(1)])

    const first = await (await get('/?page=1')).json() as any
    expect(first.next).toBe('https://test.local/actor/outbox?page=2')
    expect(first.prev).toBeUndefined()

    const middle = await (await get('/?page=2')).json() as any
    expect(middle.next).toBe('https://test.local/actor/outbox?page=3')
    expect(middle.prev).toBe('https://test.local/actor/outbox?page=1')

    const last = await (await get('/?page=3')).json() as any
    expect(last.next).toBeUndefined()
    expect(last.prev).toBe('https://test.local/actor/outbox?page=2')
  })

  it('pages from the notes store, twenty at a time', async () => {
    await get('/?page=3')
    expect(listNotes).toHaveBeenCalledWith(20, 40)
  })

  it('treats a junk page number as the first page', async () => {
    await get('/?page=nonsense')
    expect(listNotes).toHaveBeenCalledWith(20, 0)
    listNotes.mockClear()
    await get('/?page=-4')
    expect(listNotes).toHaveBeenCalledWith(20, 0)
  })

  it('reads the bot\'s own notes and nothing else', async () => {
    // Regression: this endpoint used to select from `activities` — the *inbox* archive —
    // so every public fetch republished the followed accounts' activities as if this
    // actor had authored them. getDb is rigged to throw, so any query outside the notes
    // store fails the test rather than quietly leaking the archive again.
    await expect(get('/')).resolves.toMatchObject({ status: 200 })
    await expect(get('/?page=1')).resolves.toMatchObject({ status: 200 })
    expect(getDb).not.toHaveBeenCalled()
  })
})
