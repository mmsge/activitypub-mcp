import { describe, it, expect } from 'vitest'
import { parseGardenReviews } from './fetch-garden.js'

describe('parseGardenReviews — Obsidian cache → review map', () => {
  const cacheDoc = {
    '_publish/Bøker/Meldingar/Arkiv/Om udregning af rumfang V.md': {
      frontmatter: {
        permalink: 'melding/bok/om-udregning-af-rumfang-v',
        bookwyrm: 'https://bookwyrm.social/book/1602615',
        isbn: '9788797184813',
        'språk': ['danish', 'dansk'],
        'originalspråk': 'dansk',
        'Antal sider': '312',
        image: 'https://example.test/cover.jpg',
        forfattar: ['Solvej Balle'],
        serie: 'Om udregning af rumfang',
        undertittel: null,
        teiknar: null,
      },
    },
    // A non-book note (no `bookwyrm` field) must be excluded.
    '_publish/Meldingar/Film/Civil War.md': {
      frontmatter: { permalink: 'melding/film/civil-war', image: 'x' },
    },
    // Image/binary cache entries are null and must be skipped without throwing.
    '_publish/assets/cover.jpg': null,
  }

  it('keys entries by the bookwyrm URL and maps frontmatter fields', () => {
    const m = parseGardenReviews(cacheDoc)
    expect(m.size).toBe(1)
    const r = m.get('https://bookwyrm.social/book/1602615')!
    expect(r).toMatchObject({
      bookwyrmUrl: 'https://bookwyrm.social/book/1602615',
      isbn: '9788797184813',
      language: ['danish', 'dansk'],
      originalLanguage: 'dansk',
      pages: 312, // coerced from the "312" string
      cover: 'https://example.test/cover.jpg',
      authors: ['Solvej Balle'],
      series: 'Om udregning af rumfang',
      subtitle: null,
      illustrator: null,
      reviewUrl: 'https://markus.plus/melding/bok/om-udregning-af-rumfang-v',
    })
  })

  it('excludes notes without a bookwyrm field', () => {
    const m = parseGardenReviews(cacheDoc)
    expect([...m.values()].some((r) => r.cover === 'x')).toBe(false)
  })
})
