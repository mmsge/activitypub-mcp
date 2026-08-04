import { describe, it, expect } from 'vitest'
import { parseGardenReviews, parseNoteRefs, noteAccessUrl, stripFrontmatter } from './fetch-garden.js'

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

describe('parseNoteRefs — Obsidian cache → crawlable note refs', () => {
  const cacheDoc = {
    '_publish/Hovud.md': {
      frontmatter: { permalink: '/', description: 'heim' },
    },
    '_publish/Personleg/Om meg.md': {
      frontmatter: { permalink: 'meg', title: 'Om meg' },
    },
    // Notes without a permalink are unpublished-ish; skipped like parseCache does.
    '_publish/Utkast/Kladd.md': { frontmatter: {} },
    // Binary entries are null and non-md keys must be skipped.
    '_publish/bilete/favicon.png': null,
  }

  it('includes the home page and normalizes permalinks to leading-slash paths', () => {
    const refs = parseNoteRefs(cacheDoc)
    expect(refs).toEqual([
      { sourcePath: '_publish/Hovud.md', path: '/', title: 'Hovud', date: null, tags: [], bookUrl: null },
      { sourcePath: '_publish/Personleg/Om meg.md', path: '/meg', title: 'Om meg', date: null, tags: [], bookUrl: null },
    ])
  })

  // The refs are what sync-garden-content persists, so they must carry the note's
  // own date — the stream orders a note by when it was written, not by when the
  // crawler first saw it.
  it('carries the frontmatter date and tags, preferring dato over modified', () => {
    const refs = parseNoteRefs({
      '_publish/Dagbok/Tur.md': {
        frontmatter: { permalink: 'tur', title: 'Tur', dato: '2024-03-11', modified: '2026-01-02' },
        tags: ['#reise', { tag: '#foto' }],
      },
    })
    expect(refs).toEqual([
      { sourcePath: '_publish/Dagbok/Tur.md', path: '/tur', title: 'Tur', date: '2024-03-11', tags: ['reise', 'foto'], bookUrl: null },
    ])
  })

  it('carries the bookwyrm Edition URL, which is how an undated review gets a date', () => {
    // 158 of the 282 dateless notes have this field and nothing else to go on.
    // Losing it here would silently leave them all out of the stream again.
    const refs = parseNoteRefs({
      '_publish/Meldingar/Boka.md': {
        frontmatter: {
          permalink: 'melding/boka',
          bookwyrm: 'https://bookwyrm.social/book/1763392',
          forfattar: 'Ein Forfattar',
        },
      },
    })
    expect(refs[0].bookUrl).toBe('https://bookwyrm.social/book/1763392')
    expect(refs[0].date).toBeNull()
  })

  it('leaves bookUrl null on a note that is not a book review', () => {
    const refs = parseNoteRefs({ '_publish/a.md': { frontmatter: { permalink: 'a' } } })
    expect(refs[0].bookUrl).toBeNull()
  })

  it('falls back to modified, then anskaffet, and tolerates neither', () => {
    const only = (fm: Record<string, unknown>) =>
      parseNoteRefs({ '_publish/a.md': { frontmatter: { permalink: 'a', ...fm } } })[0].date
    expect(only({ modified: '2025-05-05' })).toBe('2025-05-05')
    expect(only({ anskaffet: '2023-01-01' })).toBe('2023-01-01')
    expect(only({})).toBeNull()
  })
})

describe('noteAccessUrl', () => {
  it('percent-encodes each segment and keeps slashes literal', () => {
    expect(noteAccessUrl('_publish/Bøker/Meldingar/Arkiv/Om udregning af rumfang V.md')).toBe(
      'https://publish-01.obsidian.md/access/8528a8f5ceabc10547ce0121dbdada5d/_publish/B%C3%B8ker/Meldingar/Arkiv/Om%20udregning%20af%20rumfang%20V.md'
    )
  })
})

describe('stripFrontmatter', () => {
  it('strips a leading frontmatter block', () => {
    expect(stripFrontmatter('---\npermalink: /meg\n---\n# Hei\n\nTekst')).toBe('# Hei\n\nTekst')
  })

  it('drops one blank line following the block', () => {
    expect(stripFrontmatter('---\na: 1\n---\n\n# Hei')).toBe('# Hei')
  })

  it('returns input unchanged when there is no frontmatter', () => {
    expect(stripFrontmatter('# Hei\n\nTekst')).toBe('# Hei\n\nTekst')
  })

  it('leaves a mid-body thematic break untouched', () => {
    const doc = '# Hei\n\n---\n\nTekst'
    expect(stripFrontmatter(doc)).toBe(doc)
    expect(stripFrontmatter('---\na: 1\n---\nFør\n\n---\n\nEtter')).toBe('Før\n\n---\n\nEtter')
  })

  it('returns an unterminated opening fence unchanged', () => {
    const doc = '---\na: 1\nno closing fence'
    expect(stripFrontmatter(doc)).toBe(doc)
  })

  it('handles empty frontmatter and frontmatter-only documents', () => {
    expect(stripFrontmatter('---\n---\nTekst')).toBe('Tekst')
    expect(stripFrontmatter('---\na: 1\n---')).toBe('')
    expect(stripFrontmatter('---\na: 1\n---\n')).toBe('')
  })

  it('tolerates CRLF and a BOM', () => {
    expect(stripFrontmatter('---\r\na: 1\r\n---\r\nTekst')).toBe('Tekst')
    expect(stripFrontmatter('﻿---\na: 1\n---\nTekst')).toBe('Tekst')
  })
})
