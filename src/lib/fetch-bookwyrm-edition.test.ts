import { describe, it, expect } from 'vitest'
import { mapEdition } from './fetch-bookwyrm-edition.js'

describe('mapEdition — BookWyrm Edition AP object → metadata', () => {
  it('maps a complete prose Edition', () => {
    const m = mapEdition({
      type: 'Edition',
      id: 'https://bookwyrm.social/book/361021',
      title: 'The Radleys',
      pages: 352,
      physicalFormat: 'Paperback',
      isbn13: '9781786894670',
      publishedDate: '2019-04-04',
      languages: ['English', 'engelsk'],
      work: 'https://bookwyrm.social/book/360459',
    })
    expect(m).toMatchObject({
      bookUrl: 'https://bookwyrm.social/book/361021',
      workUrl: 'https://bookwyrm.social/book/360459',
      title: 'The Radleys',
      pages: 352,
      physicalFormat: 'Paperback',
      isbn13: '9781786894670',
      pubYear: 2019,
      language: 'English',
      pageSource: 'bookwyrm',
    })
  })

  it('records pageSource null when the Edition has no page count (caller may fall back)', () => {
    const m = mapEdition({
      type: 'Edition',
      id: 'https://bookwyrm.social/book/577271',
      title: 'Ducks',
      pages: null,
      physicalFormat: '',
      isbn13: '9781787330139',
      publishedDate: '2022-09-27',
      languages: ['English'],
    })
    expect(m.pages).toBeNull()
    expect(m.pageSource).toBeNull()
    expect(m.physicalFormat).toBeNull() // empty string normalized to null
  })

  it('falls back to firstPublishedDate for the year and tolerates a bare year', () => {
    expect(mapEdition({ id: 'u', publishedDate: '', firstPublishedDate: '2025-09-10' }).pubYear).toBe(2025)
    expect(mapEdition({ id: 'u', publishedDate: '2025' }).pubYear).toBe(2025)
    expect(mapEdition({ id: 'u' }).pubYear).toBeNull()
  })

  it('coerces a string page count and rejects non-positive values', () => {
    expect(mapEdition({ id: 'u', pages: '218' }).pages).toBe(218)
    expect(mapEdition({ id: 'u', pages: 0 }).pages).toBeNull()
  })
})
