import { describe, it, expect } from 'vitest'
import { extractContent } from './object-content.js'

describe('extractContent', () => {
  it('prefers content when present', () => {
    expect(extractContent({ content: '<p>hei</p>', contentMap: { nb: '<p>anna</p>' } })).toBe(
      '<p>hei</p>'
    )
  })

  it('falls back to the first contentMap value when content is missing or empty', () => {
    expect(extractContent({ contentMap: { nb: '<p>hei</p>' } })).toBe('<p>hei</p>')
    expect(extractContent({ content: '', contentMap: { nb: '<p>hei</p>' } })).toBe('<p>hei</p>')
  })

  it('skips non-string contentMap values', () => {
    expect(extractContent({ contentMap: { nb: 42, en: '<p>hi</p>' } })).toBe('<p>hi</p>')
  })

  it('returns null when neither field carries text', () => {
    expect(extractContent({})).toBeNull()
    expect(extractContent({ content: 17 })).toBeNull()
    expect(extractContent({ contentMap: [] })).toBeNull()
    expect(extractContent({ contentMap: { nb: '' } })).toBeNull()
  })
})
