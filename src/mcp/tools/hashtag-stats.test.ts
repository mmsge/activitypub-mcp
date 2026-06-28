import { describe, it, expect } from 'vitest'
import { normalizeHashtag } from './hashtag-stats.js'

describe('normalizeHashtag', () => {
  it('strips a single leading # and lowercases', () => {
    expect(normalizeHashtag('#BookWyrm')).toBe('bookwyrm')
    expect(normalizeHashtag('#Caturday')).toBe('caturday')
  })

  it('handles names without a leading #', () => {
    expect(normalizeHashtag('Photography')).toBe('photography')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHashtag('  #Travel  ')).toBe('travel')
  })

  it('only strips one leading #', () => {
    expect(normalizeHashtag('##meta')).toBe('#meta')
  })

  it('leaves an empty string empty', () => {
    expect(normalizeHashtag('#')).toBe('')
    expect(normalizeHashtag('')).toBe('')
  })
})
