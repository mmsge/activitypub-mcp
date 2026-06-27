import { describe, it, expect } from 'vitest'
import {
  normalizeIsbn, isValidIsbn10, isValidIsbn13, isbn10to13, isbn13to10,
  resolveBestIsbn, normalizeLanguage,
} from './isbn.js'

describe('normalizeIsbn', () => {
  it('strips hyphens/spaces and keeps a 13- or 10-digit body', () => {
    expect(normalizeIsbn('978-0-241-98826-8')).toBe('9780241988268')
    expect(normalizeIsbn(' 0 306 40615 2 ')).toBe('0306406152')
    expect(normalizeIsbn('080442957x')).toBe('080442957X')
  })
  it('rejects junk', () => {
    expect(normalizeIsbn('not-an-isbn')).toBeNull()
    expect(normalizeIsbn('12345')).toBeNull()
    expect(normalizeIsbn(null)).toBeNull()
    expect(normalizeIsbn(undefined)).toBeNull()
  })
})

describe('ISBN validation', () => {
  it('validates ISBN-13 check digits', () => {
    expect(isValidIsbn13('9780241988268')).toBe(true)
    expect(isValidIsbn13('9788797184813')).toBe(true)
    expect(isValidIsbn13('9780241988260')).toBe(false)
  })
  it('validates ISBN-10 check digits incl. X', () => {
    expect(isValidIsbn10('0306406152')).toBe(true)
    expect(isValidIsbn10('097522980X')).toBe(true)
    expect(isValidIsbn10('0306406151')).toBe(false)
  })
})

describe('ISBN 10 <-> 13 conversion', () => {
  it('round-trips a 978 book', () => {
    expect(isbn10to13('0306406152')).toBe('9780306406157')
    expect(isbn13to10('9780306406157')).toBe('0306406152')
  })
  it('returns null converting a 979 ISBN-13 to 10 (no equivalent)', () => {
    // 9791234567896 is a structurally valid 979 ISBN-13.
    expect(isbn13to10('9791234567896')).toBeNull()
  })
})

describe('resolveBestIsbn — precedence', () => {
  it('prefers the first valid candidate (Edition over review)', () => {
    const r = resolveBestIsbn([
      { value: '9780241988268', source: 'bookwyrm' },
      { value: '9788797184813', source: 'review' },
    ])
    expect(r).toEqual({ isbn13: '9780241988268', isbn10: '0241988268', source: 'bookwyrm' })
  })
  it('falls back to the review when the Edition has none', () => {
    const r = resolveBestIsbn([
      { value: null, source: 'bookwyrm' },
      { value: '9788797184813', source: 'review' },
      { value: '9780241988268', source: 'bookwyrm_object' },
    ])
    expect(r.isbn13).toBe('9788797184813')
    expect(r.source).toBe('review')
  })
  it('expands an ISBN-10 candidate to both forms', () => {
    const r = resolveBestIsbn([{ value: '0306406152', source: 'review' }])
    expect(r).toEqual({ isbn13: '9780306406157', isbn10: '0306406152', source: 'review' })
  })
  it('returns nulls when nothing is valid', () => {
    expect(resolveBestIsbn([{ value: 'garbage', source: 'bookwyrm' }])).toEqual({
      isbn13: null, isbn10: null, source: null,
    })
  })
})

describe('normalizeLanguage', () => {
  it('maps names and codes to ISO-639-1', () => {
    expect(normalizeLanguage('English')).toBe('en')
    expect(normalizeLanguage('en')).toBe('en')
    expect(normalizeLanguage('engelsk')).toBe('en')
    expect(normalizeLanguage({ key: '/languages/eng' })).toBe('en')
  })
  it('picks the first known token from an array', () => {
    expect(normalizeLanguage(['danish', 'dansk'])).toBe('da')
    expect(normalizeLanguage(['norsk', 'bokmål'])).toBe('no')
    expect(normalizeLanguage(['nynorsk'])).toBe('nn')
  })
  it('passes through unknown tokens lower-cased and handles empty', () => {
    expect(normalizeLanguage('Klingon')).toBe('klingon')
    expect(normalizeLanguage(null)).toBeNull()
    expect(normalizeLanguage([])).toBeNull()
  })
})
