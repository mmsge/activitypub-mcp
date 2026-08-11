import { describe, it, expect } from 'vitest'
import { normaliseLineName, resolveLineName, suggestLines } from './line-name.js'

/**
 * The spellings Markus actually uses. A line he can name but the tool cannot find is
 * the failure mode this file exists to prevent.
 */
describe('resolveLineName — the spellings of one line', () => {
  it('collapses Bergensbanen, Bergen Line and bergensbana onto one entry', () => {
    const slugs = ['Bergensbanen', 'Bergen Line', 'bergensbana', 'BERGENSBANEN', '  Bergensbanan  ']
      .map((n) => resolveLineName(n)?.slug)
    expect(slugs).toEqual(Array(5).fill('bergensbanen'))
  })

  it('collapses the three national spellings of the Øresund bridge', () => {
    const slugs = ['Öresundsbron', 'Øresundsbroen', 'Öresundsbroa', 'Øresundsbrua']
      .map((n) => resolveLineName(n)?.slug)
    expect(slugs).toEqual(Array(4).fill('oresundsbroa'))
  })

  it('resolves the Great Belt from either language', () => {
    expect(resolveLineName('Storebeltsbrua')?.slug).toBe('storebeltsbrua')
    expect(resolveLineName('Storebæltsbroen')?.slug).toBe('storebeltsbrua')
    expect(resolveLineName('Great Belt Bridge')?.slug).toBe('storebeltsbrua')
  })

  it('resolves the Channel Tunnel in Nynorsk, English and French', () => {
    for (const n of ['Kanaltunnelen', 'Channel Tunnel', 'Tunnel sous la Manche', 'Eurotunnel']) {
      expect(resolveLineName(n)?.slug).toBe('kanaltunnelen')
    }
  })

  it('reports which spelling got there, so a surprising hit is visible', () => {
    const hit = resolveLineName('Bergen Line')
    expect(hit).toMatchObject({ slug: 'bergensbanen', matched: 'Bergen Line', via: 'exact' })
  })

  it('knows a crossing from a line', () => {
    expect(resolveLineName('Bergensbanen')?.kind).toBe('line')
    expect(resolveLineName('Öresundsbroa')?.kind).toBe('crossing')
  })
})

describe('normaliseLineName', () => {
  it('folds the definite endings the Scandinavian languages disagree about', () => {
    const forms = ['Bergensbanen', 'Bergensbana', 'Bergensbanan'].map(normaliseLineName)
    expect(new Set(forms).size).toBe(1)
  })

  it('folds ø, æ, å, ö and ä to their unaccented forms', () => {
    expect(normaliseLineName('Østfoldbanen')).toBe(normaliseLineName('Ostfoldbanen'))
    expect(normaliseLineName('Södra stambanan')).toBe(normaliseLineName('Sodra stambanan'))
  })

  it('ignores case, spacing, hyphens and punctuation', () => {
    expect(normaliseLineName('Roa–Hønefossbanen')).toBe(normaliseLineName('roa honefossbanen'))
  })

  it('does not fold a bare ending into a line name', () => {
    // «banen» normalises to «bane», which is nobody's name — so it must not resolve.
    expect(resolveLineName('banen')).toBeNull()
  })
})

describe('suggestLines — an unknown name is never a dead end', () => {
  it('returns near matches for a misspelling rather than nothing', () => {
    const near = suggestLines('Bergensbanne').map((s) => s.slug)
    expect(near).toContain('bergensbanen')
  })

  it('returns near matches for a partial crossing name', () => {
    const near = suggestLines('Øresund').map((s) => s.slug)
    expect(near).toContain('oresundsbroa')
  })

  it('always offers something for a name nothing matches', () => {
    expect(suggestLines('Trans-Siberian').length).toBeGreaterThan(0)
  })

  it('returns nothing for an empty query rather than the whole registry', () => {
    expect(suggestLines('   ')).toEqual([])
  })
})
