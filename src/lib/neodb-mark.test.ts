import { describe, it, expect } from 'vitest'
import {
  isNeodbMark,
  parseNeodbMark,
  normalizeItemUrl,
  mapMarkStatus,
  mapItemTypeToCategory,
} from './neodb-mark.js'

// The exact payload verified against minreol's live outbox (trimmed to relevant fields).
const MARK = {
  id: 'https://minreol.dk/@markus@minreol.dk/posts/600189802906904872/',
  type: 'Note',
  attributedTo: 'https://minreol.dk/@markus@minreol.dk/',
  to: 'as:Public',
  published: '2026-07-15T12:00:00.000Z',
  updated: '2026-07-24T18:41:26.346Z',
  sensitive: false,
  content: '<p>blev færdig med at se <a href="https://minreol.dk/~neodb~/movie/50P66NqYAadUCQgfbcQhR1">American Teen</a> </p>',
  relatedWith: {
    id: 'https://minreol.dk/p/1FU8Bh0XUBFXXPngGQyger',
    type: 'Status',
    status: 'complete',
    withRegardTo: 'https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1',
    attributedTo: 'https://minreol.dk/@markus@minreol.dk/',
    href: 'https://minreol.dk/p/1FU8Bh0XUBFXXPngGQyger',
    published: '2026-07-15T12:00:00+00:00',
    updated: '2026-07-24T18:41:26.346919+00:00',
  },
  tag: {
    type: 'Movie',
    href: 'https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1',
    image: 'https://minreol.dk/m/item/imdb/2026/07/24/a921c87a.jpg',
    name: 'American Teen',
  },
  url: 'https://minreol.dk/@markus/posts/600189802906904872/',
} as const

// The other live shape: a mark made *with a comment* federates `relatedWith` as an ARRAY
// — the shelf Status plus the Comment. Verified against minreol on 2026-07-30 (the batch
// of backdated film marks). Treating only the single-object form as a mark is what made
// every commented mark invisible to the store.
const MARK_WITH_COMMENT = {
  id: 'https://minreol.dk/@markus@minreol.dk/posts/6131059108224304/',
  type: 'Note',
  attributedTo: 'https://minreol.dk/@markus@minreol.dk/',
  published: '2016-04-27T12:00:00.000Z',
  content:
    '<p>blev færdig med at se <a href="https://minreol.dk/~neodb~/movie/1pNcCQMRwquE1HOJNzGLou">Captain America: Civil War</a> <br>Sett på kino.<br></p>',
  relatedWith: [
    {
      id: 'https://minreol.dk/p/2IMl3NPTf7lPVshsjaNrjl',
      type: 'Status',
      status: 'complete',
      withRegardTo: 'https://minreol.dk/movie/1pNcCQMRwquE1HOJNzGLou',
      attributedTo: 'https://minreol.dk/@markus@minreol.dk/',
      published: '2016-04-27T12:00:00+00:00',
      updated: '2026-07-30T16:18:37.163100+00:00',
    },
    {
      id: 'https://minreol.dk/p/5h6h8wQXvpmWEqDCfxe33W',
      type: 'Comment',
      withRegardTo: 'https://minreol.dk/movie/1pNcCQMRwquE1HOJNzGLou',
      attributedTo: 'https://minreol.dk/@markus@minreol.dk/',
      content: 'Sett på kino.',
      published: '2016-04-27T12:00:00+00:00',
      updated: '2026-07-30T16:18:37.185912+00:00',
    },
  ],
  tag: {
    type: 'Movie',
    href: 'https://minreol.dk/movie/1pNcCQMRwquE1HOJNzGLou',
    image: 'https://minreol.dk/m/item/tmdb_movie/2024/07/18/0156c00e.jpg',
    name: 'Captain America: Civil War',
  },
  url: 'https://minreol.dk/@markus/posts/6131059108224304/',
} as const

const ACTOR = 'https://minreol.dk/@markus@minreol.dk/'

describe('isNeodbMark', () => {
  it('is true for a Note with a relatedWith Status pointing at a catalogue item', () => {
    expect(isNeodbMark(MARK)).toBe(true)
  })

  it('is false for an ordinary Note without relatedWith', () => {
    expect(isNeodbMark({ type: 'Note', content: 'just a toot' })).toBe(false)
  })

  it('is false when relatedWith is not a Status or lacks withRegardTo', () => {
    expect(isNeodbMark({ type: 'Note', relatedWith: { type: 'Status' } })).toBe(false)
    expect(isNeodbMark({ type: 'Note', relatedWith: { type: 'Note', withRegardTo: 'x' } })).toBe(false)
  })

  it('is true when relatedWith is an array carrying the Status (a mark with a comment)', () => {
    expect(isNeodbMark(MARK_WITH_COMMENT)).toBe(true)
  })

  it('is false for an array of related records with no Status', () => {
    expect(isNeodbMark({ type: 'Note', relatedWith: [{ type: 'Comment', withRegardTo: 'x', content: 'hi' }] }))
      .toBe(false)
  })

  it('is false for junk', () => {
    expect(isNeodbMark(null)).toBe(false)
    expect(isNeodbMark('string')).toBe(false)
    expect(isNeodbMark({ relatedWith: [] })).toBe(false)
    expect(isNeodbMark({ relatedWith: [null, 'nope'] })).toBe(false)
  })
})

describe('parseNeodbMark', () => {
  it('extracts every field from the verified payload, off tag/relatedWith not the prose', () => {
    const m = parseNeodbMark(MARK, ACTOR)!
    expect(m).not.toBeNull()
    expect(m.itemUrl).toBe('https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1')
    expect(m.actorApId).toBe(ACTOR)
    expect(m.itemType).toBe('Movie')
    expect(m.category).toBe('movie')
    expect(m.status).toBe('complete')
    expect(m.statusRaw).toBe('complete')
    expect(m.statusKnown).toBe(true)
    expect(m.title).toBe('American Teen') // from tag.name, never the "blev færdig…" prose
    expect(m.coverUrl).toBe('https://minreol.dk/m/item/imdb/2026/07/24/a921c87a.jpg')
    expect(m.markApId).toBe('https://minreol.dk/@markus@minreol.dk/posts/600189802906904872/')
    expect(m.markUrl).toBe('https://minreol.dk/@markus/posts/600189802906904872/')
    expect(m.postId).toBe('600189802906904872')
    expect(m.publishedAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z')
    expect(m.updatedAtAp?.toISOString()).toBe('2026-07-24T18:41:26.346Z')
    expect(m.watchedAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z')
  })

  it('returns null for a non-mark Note', () => {
    expect(parseNeodbMark({ type: 'Note', content: 'hi' }, ACTOR)).toBeNull()
  })

  it('derives the item URL from withRegardTo even when the tag href uses the ~neodb~ form', () => {
    const m = parseNeodbMark(
      { ...MARK, tag: { ...MARK.tag, href: 'https://minreol.dk/~neodb~/movie/50P66NqYAadUCQgfbcQhR1' } },
      ACTOR,
    )!
    expect(m.itemUrl).toBe('https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1')
    expect(m.title).toBe('American Teen') // tag still matched (normalised href) so name survives
  })

  it('maps a TVSeason mark to the tv category', () => {
    const m = parseNeodbMark(
      {
        ...MARK,
        relatedWith: { ...MARK.relatedWith, status: 'progress', withRegardTo: 'https://minreol.dk/tv/season/abc' },
        tag: { type: 'TVSeason', href: 'https://minreol.dk/tv/season/abc', name: 'Konflikt' },
      },
      ACTOR,
    )!
    expect(m.itemType).toBe('TVSeason')
    expect(m.category).toBe('tv')
    expect(m.status).toBe('progress')
  })

  it('parses an array-shaped mark off its Status entry and keeps the comment', () => {
    const m = parseNeodbMark(MARK_WITH_COMMENT, ACTOR)!
    expect(m).not.toBeNull()
    expect(m.itemUrl).toBe('https://minreol.dk/movie/1pNcCQMRwquE1HOJNzGLou')
    expect(m.status).toBe('complete')
    expect(m.category).toBe('movie')
    expect(m.title).toBe('Captain America: Civil War')
    expect(m.comment).toBe('Sett på kino.')
    // Backdated by a decade: the watched date comes off the mark, the change stamp off
    // the Status. Neither is clamped to "recent".
    expect(m.publishedAt?.toISOString()).toBe('2016-04-27T12:00:00.000Z')
    expect(m.updatedAtAp?.toISOString()).toBe('2026-07-30T16:18:37.163Z')
    expect(m.watchedAt?.toISOString()).toBe('2016-04-27T12:00:00.000Z')
  })

  it('ignores a Comment entry that points at a different catalogue item', () => {
    const m = parseNeodbMark(
      {
        ...MARK_WITH_COMMENT,
        relatedWith: [
          MARK_WITH_COMMENT.relatedWith[0],
          { ...MARK_WITH_COMMENT.relatedWith[1], withRegardTo: 'https://minreol.dk/movie/other' },
        ],
      },
      ACTOR,
    )!
    expect(m.comment).toBeNull()
  })

  it('keeps an unknown status verbatim and flags it', () => {
    const m = parseNeodbMark({ ...MARK, relatedWith: { ...MARK.relatedWith, status: 'reblogged' } }, ACTOR)!
    expect(m.status).toBe('reblogged')
    expect(m.statusKnown).toBe(false)
  })
})

// The shelf date is the whole point of the minreol backfill: the films are decades old,
// and the interesting fact is that one was seen on 9 February 2016, not that it exists.
// It lives on the `relatedWith` Status entry — nowhere else — and every plausible-looking
// neighbour (the Note's `published`, the Comment's `published`) tracks mark *creation*.
describe('parseNeodbMark — the shelf date (watchedAt)', () => {
  // Verified live: Anomalisa arrived as a Create whose Status.published was today, then an
  // Update 49 seconds later carrying the real 2016 date. minreol does not federate a
  // backdated mark on creation, so this two-step is the backfill's working procedure.
  const ANOMALISA_CREATE = {
    id: 'https://minreol.dk/@markus@minreol.dk/posts/600189802906904873/',
    type: 'Note',
    attributedTo: ACTOR,
    published: '2026-07-30T19:04:58.824Z',
    content: '<p>blev færdig med at se Anomalisa<br>Sett på kino.<br></p>',
    relatedWith: [
      {
        id: 'https://minreol.dk/p/2u1HGPDbfqhaYRIS2u1Qg0',
        type: 'Status',
        status: 'complete',
        withRegardTo: 'https://minreol.dk/movie/6qIY8Uiq2b59Qq3uMDQ1AF',
        published: '2026-07-30T19:04:58.824403+00:00',
        updated: '2026-07-30T19:04:58.824403+00:00',
      },
      {
        id: 'https://minreol.dk/p/3aBcD',
        type: 'Comment',
        withRegardTo: 'https://minreol.dk/movie/6qIY8Uiq2b59Qq3uMDQ1AF',
        content: 'Sett på kino.',
        published: '2026-07-30T19:04:58.824403+00:00',
      },
    ],
    tag: { type: 'Movie', href: 'https://minreol.dk/movie/6qIY8Uiq2b59Qq3uMDQ1AF', name: 'Anomalisa' },
  } as const

  const ANOMALISA_UPDATE = {
    ...ANOMALISA_CREATE,
    relatedWith: [
      { ...ANOMALISA_CREATE.relatedWith[0], published: '2016-02-09T12:00:00+00:00', updated: '2026-07-30T19:05:47.505415+00:00' },
      ANOMALISA_CREATE.relatedWith[1],
    ],
  }

  it('reads the date off the Status entry, not the Note and not the Comment', () => {
    const m = parseNeodbMark(ANOMALISA_UPDATE, ACTOR)!
    expect(m.watchedAt?.toISOString()).toBe('2016-02-09T12:00:00.000Z')
    // The Note's own published — and the Comment's — both track mark creation. Reading
    // the date off either would report "watched today" for every backdated mark.
    expect(m.publishedAt?.toISOString()).toBe('2026-07-30T19:04:58.824Z')
  })

  it('an Update carrying a corrected Status.published parses as the corrected date', () => {
    // The pair the backfill actually produces: Create says today, Update says 2016. The
    // Update's `updated` stamp is strictly newer, which is what lets the upsert overwrite.
    const created = parseNeodbMark(ANOMALISA_CREATE, ACTOR)!
    const updated = parseNeodbMark(ANOMALISA_UPDATE, ACTOR)!
    expect(created.watchedAt?.toISOString()).toBe('2026-07-30T19:04:58.824Z')
    expect(updated.watchedAt?.toISOString()).toBe('2016-02-09T12:00:00.000Z')
    expect(updated.itemUrl).toBe(created.itemUrl)
    expect(updated.actorApId).toBe(created.actorApId)
    expect(updated.updatedAtAp!.getTime()).toBeGreaterThan(created.updatedAtAp!.getTime())
  })

  it('keeps the Status entry in raw so the column can be backfilled from it later', () => {
    const m = parseNeodbMark(ANOMALISA_UPDATE, ACTOR)!
    expect((m.raw.relatedWith as Record<string, unknown>).published).toBe('2016-02-09T12:00:00+00:00')
  })

  it('parses the local-midnight offset minreol\u2019s own date picker sends', () => {
    // The UI produces shapes like 22:00:00+00:53 rather than our importer's clean
    // T12:00:00+00:00. Both are instants; neither may be rejected or truncated.
    const m = parseNeodbMark(
      { ...MARK, relatedWith: { ...MARK.relatedWith, published: '2016-02-09T22:00:00+00:53' } },
      ACTOR,
    )!
    expect(m.watchedAt?.toISOString()).toBe('2016-02-09T21:07:00.000Z')
  })

  it('is null — never a guess — when the Status carries no published', () => {
    const { published: _dropped, ...noPublished } = MARK.relatedWith
    const m = parseNeodbMark({ ...MARK, relatedWith: noPublished }, ACTOR)!
    expect(m.watchedAt).toBeNull()
    // The Note still has its own published; it must not leak in as the shelf date.
    expect(m.publishedAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z')
  })

  it('is set for a non-film mark too — books, music and games carry the same Status', () => {
    const m = parseNeodbMark(
      {
        ...MARK,
        relatedWith: { ...MARK.relatedWith, status: 'complete', withRegardTo: 'https://minreol.dk/book/xyz', published: '2015-11-03T12:00:00+00:00' },
        tag: { type: 'Edition', href: 'https://minreol.dk/book/xyz', name: 'Naiv. Super' },
      },
      ACTOR,
    )!
    expect(m.category).toBe('book')
    expect(m.watchedAt?.toISOString()).toBe('2015-11-03T12:00:00.000Z')
  })
})

describe('normalizeItemUrl', () => {
  it('strips a ~neodb~ segment and any trailing slash to one canonical key', () => {
    const canonical = 'https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1'
    expect(normalizeItemUrl('https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1')).toBe(canonical)
    expect(normalizeItemUrl('https://minreol.dk/movie/50P66NqYAadUCQgfbcQhR1/')).toBe(canonical)
    expect(normalizeItemUrl('https://minreol.dk/~neodb~/movie/50P66NqYAadUCQgfbcQhR1')).toBe(canonical)
    expect(normalizeItemUrl('https://minreol.dk/~neodb~/movie/50P66NqYAadUCQgfbcQhR1/')).toBe(canonical)
  })

  it('returns null for empty/non-string input', () => {
    expect(normalizeItemUrl('')).toBeNull()
    expect(normalizeItemUrl(null)).toBeNull()
    expect(normalizeItemUrl(undefined)).toBeNull()
  })
})

describe('mapMarkStatus', () => {
  it('maps the full known NeoDB shelf vocabulary', () => {
    expect(mapMarkStatus('wishlist')).toMatchObject({ status: 'wishlist', known: true })
    expect(mapMarkStatus('progress')).toMatchObject({ status: 'progress', known: true })
    expect(mapMarkStatus('complete')).toMatchObject({ status: 'complete', known: true })
    expect(mapMarkStatus('dropped')).toMatchObject({ status: 'dropped', known: true })
  })

  it('lowercases and keeps an unknown verb rather than dropping it', () => {
    expect(mapMarkStatus('Fediverse')).toMatchObject({ status: 'fediverse', raw: 'Fediverse', known: false })
  })

  it('is null for missing/blank input', () => {
    expect(mapMarkStatus(null)).toMatchObject({ status: null, known: false })
    expect(mapMarkStatus('   ')).toMatchObject({ status: null, known: false })
  })
})

describe('mapItemTypeToCategory', () => {
  it('maps AP tag types to NeoDB categories', () => {
    expect(mapItemTypeToCategory('Movie')).toBe('movie')
    expect(mapItemTypeToCategory('TVShow')).toBe('tv')
    expect(mapItemTypeToCategory('TVSeason')).toBe('tv')
    expect(mapItemTypeToCategory('TVEpisode')).toBe('tv')
    expect(mapItemTypeToCategory('Edition')).toBe('book')
    expect(mapItemTypeToCategory('Album')).toBe('music')
    expect(mapItemTypeToCategory('Game')).toBe('game')
    expect(mapItemTypeToCategory('Podcast')).toBe('podcast')
    expect(mapItemTypeToCategory('Performance')).toBe('performance')
  })

  it('is null for an unknown or missing type', () => {
    expect(mapItemTypeToCategory('Hashtag')).toBeNull()
    expect(mapItemTypeToCategory(null)).toBeNull()
  })
})
