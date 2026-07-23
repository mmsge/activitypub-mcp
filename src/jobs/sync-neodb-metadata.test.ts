import { describe, it, expect } from 'vitest'
import { isNeodbBookUrl, collectNeodbTagHrefs, extractMarkTitles, NEODB_MEDIA_TAG_TYPES } from './sync-neodb-metadata.js'

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

describe('extractMarkTitles', () => {
  const url = 'https://minreol.dk/tv/season/2mHcVZbJprJFqdIYBwnjTU'

  it('returns the mark tag name for a media tag matching the item URL', () => {
    // The Conflict/Konflikt case: the mark federates the name "Conflict" while NeoDB's
    // title is the localized "Konflikt".
    const tags = [{ type: 'TVSeason', href: url, name: 'Conflict' }]
    expect(extractMarkTitles(tags, url)).toEqual(['Conflict'])
  })

  it('picks up an Edition tag name (NeoDB books)', () => {
    const bookUrl = 'https://minreol.dk/book/6wVnEgPerssEOqlD8hvlLg'
    const tags = [{ type: 'Edition', href: bookUrl, name: 'Some Book' }]
    expect(extractMarkTitles(tags, bookUrl)).toEqual(['Some Book'])
  })

  it('ignores tags for a different href', () => {
    const tags = [
      { type: 'TVSeason', href: url, name: 'Conflict' },
      { type: 'Movie', href: 'https://minreol.dk/movie/other', name: 'Other' },
    ]
    expect(extractMarkTitles(tags, url)).toEqual(['Conflict'])
  })

  it('ignores non-media tags and empty/missing names', () => {
    const tags = [
      { type: 'Hashtag', href: url, name: 'SomeHashtag' }, // wrong type
      { type: 'TVSeason', href: url, name: '   ' }, // blank
      { type: 'TVSeason', href: url }, // no name
    ]
    expect(extractMarkTitles(tags, url)).toEqual([])
  })

  it('dedupes repeated names and trims whitespace', () => {
    const tags = [
      { type: 'TVSeason', href: url, name: 'Conflict' },
      { type: 'TVSeason', href: url, name: '  Conflict  ' },
    ]
    expect(extractMarkTitles(tags, url)).toEqual(['Conflict'])
  })

  it('returns every distinct alias when marks used different names', () => {
    const tags = [
      { type: 'TVSeason', href: url, name: 'Conflict' },
      { type: 'TVSeason', href: url, name: 'Konflikt' },
    ]
    expect(extractMarkTitles(tags, url).sort()).toEqual(['Conflict', 'Konflikt'])
  })

  it('tolerates non-array input', () => {
    expect(extractMarkTitles(null, url)).toEqual([])
    expect(extractMarkTitles(undefined, url)).toEqual([])
  })
})
