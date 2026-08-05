import { describe, it, expect } from 'vitest'
import { journeySlug } from './journeys.js'

describe('journeySlug', () => {
  it('slugs the real journey names', () => {
    expect(journeySlug('NDC Copenhagen 2026')).toBe('ndc-copenhagen-2026')
    expect(journeySlug('UK rail 2023')).toBe('uk-rail-2023')
    expect(journeySlug('Kaizershausten 26')).toBe('kaizershausten-26')
    expect(journeySlug('Before the Bloom Berlin')).toBe('before-the-bloom-berlin')
  })

  it('transliterates the Norwegian letters rather than percent-encoding them', () => {
    // `sjaelland-rundt` survives being pasted into a chat window; the encoded form
    // `sj%C3%A6lland-rundt` does not.
    expect(journeySlug('Sjælland rundt')).toBe('sjaelland-rundt')
    expect(journeySlug('Bryllaupsreisa')).toBe('bryllaupsreisa')
    expect(journeySlug('Grønøy og Åsen')).toBe('gronoy-og-asen')
  })

  it('strips accents without dropping the letter', () => {
    expect(journeySlug('Café Zürich')).toBe('cafe-zurich')
    expect(journeySlug('Málaga')).toBe('malaga')
  })

  it('collapses punctuation and trims the edges', () => {
    expect(journeySlug('  Noregsferie — 2024!  ')).toBe('noregsferie-2024')
    expect(journeySlug('a/b\\c')).toBe('a-b-c')
    expect(journeySlug('Trondheim, januar 2026')).toBe('trondheim-januar-2026')
  })

  it('is idempotent — slugging a slug changes nothing', () => {
    // The detail page compares a URL segment against freshly-slugged names, so a
    // slug that re-slugged differently would 404 on its own link.
    for (const name of ['Sjælland rundt', 'NDC Copenhagen 2026', 'Café Zürich']) {
      const once = journeySlug(name)
      expect(journeySlug(once)).toBe(once)
    }
  })

  it('yields an empty slug for a name with nothing sluggable', () => {
    // Not a crash, and not a URL either — loadJourney simply will not match it.
    expect(journeySlug('!!!')).toBe('')
    expect(journeySlug('')).toBe('')
  })
})
