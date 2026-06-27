import { describe, it, expect } from 'vitest'
import {
  mapEdition, mapOpenLibrary, mapGoogleBooks, mergeBookMetadata,
  type EditionMetadata, type ExternalBookData,
} from './fetch-bookwyrm-edition.js'
import type { ReviewMeta } from './fetch-garden.js'

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

  it('extracts cover, description (HTML-stripped), publisher, subjects, isbn10, subtitle', () => {
    const m = mapEdition({
      id: 'https://bookwyrm.social/book/1602615',
      title: 'Om udregning af rumfang V',
      subtitle: '',
      description: '<p>Femte del af <i>romanen</i>.</p>',
      cover: { type: 'Image', url: 'https://covers.test/x.jpeg' },
      publishers: ['Pelagraf'],
      subjects: [],
      isbn13: '9788797184813',
      isbn10: '8797184810',
      languages: ['danish', 'dansk'],
    })
    expect(m.coverUrl).toBe('https://covers.test/x.jpeg')
    expect(m.description).toBe('Femte del af romanen.')
    expect(m.publisher).toBe('Pelagraf')
    expect(m.subjects).toBeNull() // empty array → null
    expect(m.isbn10).toBe('8797184810')
    expect(m.subtitle).toBeNull() // empty string → null
    expect(m.language).toBe('danish') // raw; normalized only at merge
  })
})

describe('mapOpenLibrary', () => {
  it('maps cover/subjects/publisher/pages from a jscmd=data entry', () => {
    const d = mapOpenLibrary({
      number_of_pages: 336,
      cover: { small: 's', medium: 'm', large: 'L' },
      publishers: [{ name: 'Penguin Books, Limited' }],
      publish_date: '2021-05-13',
      subjects: [{ name: 'Mystery' }, { name: 'Fiction' }],
    }, '9780241988268')
    expect(d).toMatchObject({
      pages: 336,
      coverUrl: 'L',
      publisher: 'Penguin Books, Limited',
      publishedDate: '2021-05-13',
      subjects: ['Mystery', 'Fiction'],
      isbn13: '9780241988268',
    })
  })
})

describe('mapGoogleBooks', () => {
  const expected = { isbn13: '9780241988268', isbn10: '0241988268' }
  it('maps thumbnail/categories/description/language', () => {
    const d = mapGoogleBooks({
      pageCount: 400,
      imageLinks: { smallThumbnail: 's', thumbnail: 't' },
      categories: ['Fiction'],
      description: '<b>A mystery.</b>',
      language: 'en',
      publisher: 'Penguin',
      publishedDate: '2021',
      industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780241988268' }],
    }, expected)
    expect(d).not.toBeNull()
    expect(d).toMatchObject({ pages: 400, coverUrl: 't', subjects: ['Fiction'], description: 'A mystery.', language: 'en' })
  })
  it('drops a wrong-edition volume (identifiers do not include the queried ISBN)', () => {
    const d = mapGoogleBooks({
      pageCount: 999,
      industryIdentifiers: [{ type: 'ISBN_13', identifier: '9789999999999' }],
    }, expected)
    expect(d).toBeNull()
  })
})

describe('mergeBookMetadata — precedence (Edition authoritative)', () => {
  const baseEdition = (over: Partial<EditionMetadata> = {}): EditionMetadata => ({
    bookUrl: 'https://bookwyrm.social/book/1', workUrl: null, title: 'T', subtitle: null,
    pages: null, physicalFormat: 'Paperback', isbn13: null, isbn10: null, pubYear: null,
    language: null, publisher: null, series: null, coverUrl: null, description: null,
    subjects: null, pageSource: null, ...over,
  })
  const review = (over: Partial<ReviewMeta> = {}): ReviewMeta => ({
    bookwyrmUrl: 'https://bookwyrm.social/book/1', isbn: null, language: null,
    originalLanguage: null, pages: null, cover: null, authors: null, series: null,
    subtitle: null, illustrator: null, reviewUrl: null, ...over,
  })
  const external = (over: Partial<ExternalBookData> = {}): ExternalBookData => ({
    pages: null, coverUrl: null, description: null, publisher: null, publishedDate: null,
    language: null, subjects: null, isbn10: null, isbn13: null, ...over,
  })

  it('Edition wins pages/language/cover over review and external', () => {
    const m = mergeBookMetadata({
      edition: baseEdition({ pages: 200, language: 'English', coverUrl: 'edcover' }),
      review: review({ pages: 999, language: ['danish'], cover: 'revcover' }),
      openLibrary: external({ pages: 111, coverUrl: 'olcover', language: 'fr' }),
    })
    expect(m.pages).toBe(200)
    expect(m.language).toBe('en') // normalized from Edition's "English"
    expect(m.coverUrl).toBe('edcover')
    expect(m.sourceMap.pages).toBe('bookwyrm')
    expect(m.pageSource).toBe('bookwyrm')
  })

  it('review fills gaps the Edition lacks; external fills what is left', () => {
    const m = mergeBookMetadata({
      edition: baseEdition({ language: null, pages: null, coverUrl: null, series: null }),
      review: review({ language: ['danish', 'dansk'], pages: 312, cover: 'revcover', series: 'Saga', originalLanguage: 'dansk' }),
      openLibrary: external({ publisher: 'Pelagraf', subjects: ['Fiction'], coverUrl: 'olcover' }),
    })
    expect(m.language).toBe('da')
    expect(m.sourceMap.language).toBe('review')
    expect(m.pages).toBe(312)
    expect(m.coverUrl).toBe('revcover') // review beats OpenLibrary
    expect(m.series).toBe('Saga')
    expect(m.originalLanguage).toBe('da')
    expect(m.publisher).toBe('Pelagraf')
    expect(m.sourceMap.publisher).toBe('openlibrary')
  })

  it('resolves the ISBN by precedence and records the source', () => {
    const m = mergeBookMetadata({
      edition: baseEdition({ isbn13: null, isbn10: null }),
      review: review({ isbn: '9788797184813' }),
    })
    expect(m.isbn13).toBe('9788797184813')
    expect(m.isbnSource).toBe('review')
  })

  it('flags an ISBN mismatch between Edition and review and trusts the Edition', () => {
    const m = mergeBookMetadata({
      edition: baseEdition({ isbn13: '9780241988268' }),
      review: review({ isbn: '9788797184813' }),
    })
    expect(m.isbn13).toBe('9780241988268')
    expect(m.isbnSource).toBe('bookwyrm')
    expect(m.sourceMap.isbnMismatch).toBe('override')
  })
})
