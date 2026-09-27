import { describe, it, expect } from 'vitest'
import { isNeodbBookUrl, collectNeodbTagHrefs, extractMarkTitles, NEODB_MEDIA_TAG_TYPES, catalogUpsertValues, TITLE_PLACEHOLDER_ERROR, isNeodbPerformanceUrl } from './sync-neodb-metadata.js'
import { mapNeodbItem } from '../lib/fetch-neodb-item.js'

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

describe('the URL-as-title trap (theatre drafted from a web page)', () => {
  const url = 'https://minreol.dk/performance/1z2DQbq0PQZTICNDSTBI0q'

  it('never keeps a URL-shaped mark name as an alias', () => {
    const tags = [
      { type: 'Performance', href: url, name: 'https://www.riksteatret.no/repertoar/ubesvart-anrop/' },
      { type: 'Performance', href: url, name: 'Ubesvart anrop' },
    ]
    expect(extractMarkTitles(tags, url)).toEqual(['Ubesvart anrop'])
  })

  it('writes a placeholder-titled row as still owed, so the next pass re-reads it', () => {
    const meta = mapNeodbItem(url, {
      type: 'Performance', category: 'performance',
      title: 'https://www.riksteatret.no/repertoar/ubesvart-anrop/',
      display_title: 'https://www.riksteatret.no/repertoar/ubesvart-anrop/',
      orig_title: 'Ubesvart anrop (Riksteatret)',
    })
    const owed = catalogUpsertValues(meta, [], {}, new Date())
    expect(owed.title).toBe('Ubesvart anrop (Riksteatret)')
    expect(owed.fetchError).toBe(TITLE_PLACEHOLDER_ERROR)
    // enrichedAt is still set: the row is listed while it waits for its name.
    expect(owed.enrichedAt).toBeInstanceOf(Date)

    const named = catalogUpsertValues(mapNeodbItem(url, { type: 'Performance', category: 'performance', title: 'Ubesvart anrop' }), [], {}, new Date())
    expect(named.fetchError).toBeNull()
    expect(named.fetchAttempts).toBe(0)
  })
})

describe('isNeodbPerformanceUrl', () => {
  it('is true for a play and for a production, in either URL form', () => {
    expect(isNeodbPerformanceUrl('https://minreol.dk/performance/1z2DQbq0PQZTICNDSTBI0q')).toBe(true)
    expect(isNeodbPerformanceUrl('https://minreol.dk/performance/production/4AbcDefGhiJklMnoPqrStu')).toBe(true)
    expect(isNeodbPerformanceUrl('https://minreol.dk/~neodb~/performance/1z2DQbq0PQZTICNDSTBI0q')).toBe(true)
  })

  it('is false for everything else', () => {
    expect(isNeodbPerformanceUrl('https://minreol.dk/movie/abc')).toBe(false)
    expect(isNeodbPerformanceUrl('https://www.riksteatret.no/repertoar/ubesvart-anrop/')).toBe(false)
    expect(isNeodbPerformanceUrl('not a url')).toBe(false)
    expect(isNeodbPerformanceUrl(undefined)).toBe(false)
  })
})
