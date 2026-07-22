import { describe, it, expect } from 'vitest'
import { normalizeSubjects } from './subjects.js'

describe('normalizeSubjects', () => {
  it('strips genre:/series:/tag: prefixes', () => {
    expect(normalizeSubjects(['genre:LitRPG', 'series:Dungeon Crawler Carl', 'tag: cosy'])).toEqual([
      'LitRPG',
      'Dungeon Crawler Carl',
      'cosy',
    ])
  })

  it('dedups case-insensitively, first casing wins — including prefix/bare collisions', () => {
    expect(normalizeSubjects(['LitRPG', 'genre:litrpg', 'Fantasy', 'fantasy'])).toEqual([
      'LitRPG',
      'Fantasy',
    ])
  })

  it('keeps ordinary subjects untouched (colons mid-string are not prefixes)', () => {
    expect(normalizeSubjects(['Fiction / Science Fiction', 'World War, 1939-1945'])).toEqual([
      'Fiction / Science Fiction',
      'World War, 1939-1945',
    ])
  })

  it('drops non-strings and empties; null for nothing left or non-arrays', () => {
    expect(normalizeSubjects(['', '  ', 42, null, 'Real'])).toEqual(['Real'])
    expect(normalizeSubjects(['', 'genre: '])).toBeNull()
    expect(normalizeSubjects('Fantasy')).toBeNull()
    expect(normalizeSubjects(null)).toBeNull()
  })
})
