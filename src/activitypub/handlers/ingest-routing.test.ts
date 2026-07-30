import { describe, it, expect, vi, beforeEach } from 'vitest'

// The three inbox paths must funnel into one ingest. These tests pin the routing — what
// each handler unwraps, whom it attributes the object to, and what it refuses to store —
// with the storage layer itself mocked out.

const ingestObject = vi.fn(async () => {})
const fetchApObject = vi.fn(async (_url: string): Promise<Record<string, unknown> | null> => null)

vi.mock('./create.js', () => ({ ingestObject }))
vi.mock('../../lib/fetch-ap-object.js', () => ({ fetchApObject }))

const { handleAnnounce } = await import('./announce.js')
const { handleUpdate } = await import('./update.js')

const NEODB_ACTOR = 'https://minreol.dk/@markus@minreol.dk/'
const MASTODON_ACTOR = 'https://skvip.lol/users/markus'
const NOTE_ID = 'https://minreol.dk/@markus@minreol.dk/posts/6131059108224304/'

const MARK_NOTE = {
  id: NOTE_ID,
  type: 'Note',
  attributedTo: NEODB_ACTOR,
  published: '2016-04-27T12:00:00.000Z',
  content: '<p>blev færdig med at se Captain America: Civil War <br>Sett på kino.<br></p>',
  relatedWith: [{ type: 'Status', status: 'complete', withRegardTo: 'https://minreol.dk/movie/1pN' }],
  tag: { type: 'Movie', href: 'https://minreol.dk/movie/1pN', name: 'Captain America: Civil War' },
}

beforeEach(() => {
  ingestObject.mockClear()
  fetchApObject.mockClear()
  fetchApObject.mockResolvedValue(null)
})

describe('handleAnnounce', () => {
  it('dereferences a boosted post sent as a bare URI and ingests it as its author', async () => {
    fetchApObject.mockResolvedValue(MARK_NOTE)
    await handleAnnounce({ type: 'Announce', actor: MASTODON_ACTOR, object: NOTE_ID })

    expect(fetchApObject).toHaveBeenCalledWith(NOTE_ID)
    // Attributed to the NeoDB account that made the mark, not to the account that
    // boosted it — otherwise a boosted mark files under the wrong actor.
    expect(ingestObject).toHaveBeenCalledWith(MARK_NOTE, NEODB_ACTOR, { source: 'announce' })
  })

  it('ingests an embedded object without a network round-trip', async () => {
    await handleAnnounce({ type: 'Announce', actor: MASTODON_ACTOR, object: MARK_NOTE })
    expect(fetchApObject).not.toHaveBeenCalled()
    expect(ingestObject).toHaveBeenCalledWith(MARK_NOTE, NEODB_ACTOR, { source: 'announce' })
  })

  it('resolves an embedded {id, type} stub rather than storing a contentless row', async () => {
    fetchApObject.mockResolvedValue(MARK_NOTE)
    await handleAnnounce({
      type: 'Announce',
      actor: MASTODON_ACTOR,
      object: { id: NOTE_ID, type: 'Note' },
    })
    expect(fetchApObject).toHaveBeenCalledWith(NOTE_ID)
    expect(ingestObject).toHaveBeenCalledWith(MARK_NOTE, NEODB_ACTOR, { source: 'announce' })
  })

  it('stores nothing when the boosted object cannot be resolved', async () => {
    await handleAnnounce({
      type: 'Announce',
      actor: MASTODON_ACTOR,
      object: { id: NOTE_ID, type: 'Note' },
    })
    expect(ingestObject).not.toHaveBeenCalled()
  })

  it('falls back to the announcer when the boosted object carries no attribution', async () => {
    const orphan = { id: 'https://elsewhere/1', type: 'Note', content: '<p>hi</p>' }
    await handleAnnounce({ type: 'Announce', actor: MASTODON_ACTOR, object: orphan })
    expect(ingestObject).toHaveBeenCalledWith(orphan, MASTODON_ACTOR, { source: 'announce' })
  })
})

describe('handleUpdate', () => {
  it('upserts the edited object, so an edit to a post we never saw creates it', async () => {
    await handleUpdate({ type: 'Update', actor: NEODB_ACTOR, object: MARK_NOTE })
    expect(ingestObject).toHaveBeenCalledWith(MARK_NOTE, NEODB_ACTOR, { source: 'update' })
  })

  it('ignores an actor profile update — a Person is not a post', async () => {
    await handleUpdate({
      type: 'Update',
      actor: NEODB_ACTOR,
      object: { id: NEODB_ACTOR, type: 'Person', name: 'Markus' },
    })
    expect(ingestObject).not.toHaveBeenCalled()
  })

  it('ignores an Update with no object id', async () => {
    await handleUpdate({ type: 'Update', actor: NEODB_ACTOR, object: { type: 'Note', content: 'x' } })
    expect(ingestObject).not.toHaveBeenCalled()
  })
})
