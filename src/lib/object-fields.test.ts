import { describe, it, expect } from 'vitest'
import { extractAttachments, extractTags, extractLanguage } from './object-fields.js'

describe('extractTags', () => {
  it('returns [] when there is no tag field', () => {
    expect(extractTags({})).toEqual([])
    expect(extractTags({ tag: null })).toEqual([])
  })

  it('wraps a single tag object in an array', () => {
    const t = { type: 'Hashtag', name: '#togselfie' }
    expect(extractTags({ tag: t })).toEqual([t])
  })

  it('passes an array of tags through', () => {
    const tags = [
      { type: 'Hashtag', name: '#togtut' },
      { type: 'Hashtag', name: '#togselfie' },
    ]
    expect(extractTags({ tag: tags })).toEqual(tags)
  })

  it('recovers a hashtag added by an edit (the togselfie regression)', () => {
    // The stored row froze `tags` at [togtut] while the text gained #TogSelfie.
    // Re-deriving from the current raw object restores the full set.
    const rawAfterEdit = {
      content: '<p>Eg skal ikkje ta dette toget før i oktober … #TogTut #TogSelfie</p>',
      tag: [
        { type: 'Hashtag', name: '#togtut', href: 'https://skvip.lol/tags/togtut' },
        { type: 'Hashtag', name: '#togselfie', href: 'https://skvip.lol/tags/togselfie' },
      ],
    }
    const names = extractTags(rawAfterEdit).map((t) => (t as { name: string }).name)
    expect(names).toContain('#togselfie')
  })
})

describe('extractAttachments', () => {
  it('returns [] when there is no attachment field', () => {
    expect(extractAttachments({})).toEqual([])
    expect(extractAttachments({ attachment: null })).toEqual([])
  })

  it('wraps a single attachment in an array', () => {
    const a = { type: 'Document', mediaType: 'image/jpeg', url: 'https://x/y.jpg' }
    expect(extractAttachments({ attachment: a })).toEqual([a])
  })

  it('passes an array of attachments through', () => {
    const atts = [{ url: 'a.jpg' }, { url: 'b.jpg' }]
    expect(extractAttachments({ attachment: atts })).toEqual(atts)
  })
})

describe('extractLanguage', () => {
  it('returns the first contentMap key', () => {
    expect(extractLanguage({ contentMap: { nn: 'hei', en: 'hi' } })).toBe('nn')
  })

  it('returns null without a usable contentMap', () => {
    expect(extractLanguage({})).toBeNull()
    expect(extractLanguage({ contentMap: null })).toBeNull()
    expect(extractLanguage({ contentMap: ['nope'] as unknown as Record<string, string> })).toBeNull()
  })
})
