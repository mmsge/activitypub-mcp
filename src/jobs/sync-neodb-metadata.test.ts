import { describe, it, expect } from 'vitest'
import { isNeodbBookUrl, collectNeodbTagHrefs, NEODB_MEDIA_TAG_TYPES } from './sync-neodb-metadata.js'

describe('isNeodbBookUrl', () => {
  it('is true for a NeoDB book URL (base62 id with letters)', () => {
    expect(isNeodbBookUrl('https://minreol.dk/book/6wVnEgPerssEOqlD8hvlLg')).toBe(true)
    expect(isNeodbBookUrl('https://neodb.social/book/2mHcVZbJprJFqdIYBwnjTU')).toBe(true)
  })

  it('is false for a BookWyrm Edition URL (numeric id)', () => {
    expect(isNeodbBookUrl('https://bookwyrm.social/book/123456')).toBe(false)
    expect(isNeodbBookUrl('https://bookwyrm.social/book/123456/s/some-slug')).toBe(false)
  })

  it('is false for non-book paths and junk', () => {
    expect(isNeodbBookUrl('https://minreol.dk/tv/season/2mHcVZbJprJFqdIYBwnjTU')).toBe(false)
    expect(isNeodbBookUrl('not a url')).toBe(false)
  })
})

describe('collectNeodbTagHrefs', () => {
  it('collects every NeoDB media-type tag href', () => {
    const tags = [
      { type: 'TVSeason', href: 'https://minreol.dk/tv/season/aaa' },
      { type: 'Movie', href: 'https://minreol.dk/movie/bbb' },
      { type: 'Album', href: 'https://minreol.dk/album/ccc' },
      { type: 'Game', href: 'https://minreol.dk/game/ddd' },
      { type: 'Podcast', href: 'https://minreol.dk/podcast/eee' },
      { type: 'Performance', href: 'https://minreol.dk/performance/fff' },
    ]
    expect(collectNeodbTagHrefs(tags).sort()).toEqual([
      'https://minreol.dk/album/ccc',
      'https://minreol.dk/game/ddd',
      'https://minreol.dk/movie/bbb',
      'https://minreol.dk/performance/fff',
      'https://minreol.dk/podcast/eee',
      'https://minreol.dk/tv/season/aaa',
    ])
  })

  it('includes an Edition tag only when it is a NeoDB book URL', () => {
    const tags = [
      { type: 'Edition', href: 'https://minreol.dk/book/6wVnEgPerssEOqlD8hvlLg' }, // NeoDB → in
      { type: 'Edition', href: 'https://bookwyrm.social/book/98765' }, // BookWyrm → out
    ]
    expect(collectNeodbTagHrefs(tags)).toEqual(['https://minreol.dk/book/6wVnEgPerssEOqlD8hvlLg'])
  })

  it('ignores non-tag input and tags without an href', () => {
    expect(collectNeodbTagHrefs(null)).toEqual([])
    expect(collectNeodbTagHrefs([{ type: 'Movie' }, { type: 'Hashtag', href: 'x' }])).toEqual([])
  })

  it('exposes the full NeoDB media type set', () => {
    expect(NEODB_MEDIA_TAG_TYPES).toContain('Album')
    expect(NEODB_MEDIA_TAG_TYPES).toContain('Performance')
    expect(NEODB_MEDIA_TAG_TYPES).not.toContain('Edition') // books routed by URL, not type
  })
})
