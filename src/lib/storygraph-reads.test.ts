import { describe, it, expect } from 'vitest'
import type { CollapsedBook, ReadingCycle } from './bookwyrm-reading.js'
import { cycleDateSources } from './bookwyrm-reading.js'
import {
  bookWindowSources,
  collapseKey,
  matchStorygraphBook,
  mergeStorygraphReads,
  normalizeMatchText,
  type MatchCandidate,
} from './storygraph-reads.js'

const d = (s: string) => new Date(`${s}T12:00:00Z`)
const day = (x: Date | null) => x?.toISOString().slice(0, 10) ?? null

function cycle(started: string | null, finished: string | null, n = 1, abandoned: string | null = null): ReadingCycle {
  return { started: started ? d(started) : null, finished: finished ? d(finished) : null, abandoned: abandoned ? d(abandoned) : null, cycle: n }
}

function book(title: string, cycles: ReadingCycle[]): CollapsedBook {
  return {
    title,
    author: null,
    url: null,
    cover: null,
    shelf: 'read',
    started: cycles.find((c) => c.started)?.started ?? null,
    finished: [...cycles].reverse().find((c) => c.finished)?.finished ?? null,
    abandoned: null,
    rating: null,
    lastActivity: null,
    cycles,
  }
}

const windows = (b: CollapsedBook) => b.cycles.map((c) => [day(c.started), day(c.finished)])

describe('mergeStorygraphReads — the story\'s own examples', () => {
  it('Om udregning af rumfang I: a finish-only cycle gets its StoryGraph start', () => {
    const out = mergeStorygraphReads(book('Om udregning af rumfang I', [cycle(null, '2024-03-17')]), [
      { started: '2024-03-15', finished: '2024-03-17' },
    ])
    expect(day(out.book.started)).toBe('2024-03-15')
    expect(day(out.book.finished)).toBe('2024-03-17')
    expect(out.startsFilled).toBe(1)
    expect(out.conflicts).toEqual([])
    expect(bookWindowSources(out.book)).toEqual({ started: 'storygraph', finished: 'bookwyrm' })
  })

  it('Om udregning af rumfang III: both sides agree, nothing changes', () => {
    const b = book('Om udregning af rumfang III', [cycle('2024-03-22', '2024-03-24')])
    const out = mergeStorygraphReads(b, [{ started: '2024-03-22', finished: '2024-03-24' }])
    expect(out.startsFilled + out.finishesFilled + out.readsAdded).toBe(0)
    expect(out.conflicts).toEqual([])
    expect(bookWindowSources(out.book)).toEqual({ started: 'bookwyrm', finished: 'bookwyrm' })
  })

  it('Ducks: a reread returns one window per read', () => {
    const b = book('Ducks', [cycle(null, '2024-10-02', 1), cycle('2026-05-28', '2026-05-29', 2)])
    const out = mergeStorygraphReads(b, [
      { started: '2024-09-29', finished: '2024-10-02' },
      { started: '2026-05-28', finished: '2026-05-29' },
    ])
    expect(windows(out.book)).toEqual([
      ['2024-09-29', '2024-10-02'],
      ['2026-05-28', '2026-05-29'],
    ])
    expect(day(out.book.started)).toBe('2024-09-29')
  })
})

describe('mergeStorygraphReads — rules', () => {
  it('never overwrites a BookWyrm date, and logs the disagreement', () => {
    const out = mergeStorygraphReads(book('X', [cycle('2024-03-10', '2024-03-17')]), [
      { started: '2024-03-12', finished: '2024-03-18' },
    ])
    expect(windows(out.book)).toEqual([['2024-03-10', '2024-03-17']])
    expect(out.conflicts).toEqual([
      { book: 'X', field: 'finished', bookwyrm: '2024-03-17', storygraph: '2024-03-18', reason: 'disagree' },
      { book: 'X', field: 'started', bookwyrm: '2024-03-10', storygraph: '2024-03-12', reason: 'disagree' },
    ])
  })

  it('refuses a start that would land after BookWyrm\'s finish', () => {
    const out = mergeStorygraphReads(book('X', [cycle(null, '2024-03-10')]), [{ started: '2024-03-12', finished: '2024-03-15' }])
    expect(out.book.cycles[0].started).toBeNull()
    expect(out.conflicts.map((c) => c.reason)).toEqual(['disagree', 'start_after_finish'])
  })

  it('adds a read BookWyrm never saw as its own cycle, renumbered in order', () => {
    const out = mergeStorygraphReads(book('X', [cycle('2025-01-01', '2025-01-05')]), [{ started: '2020-06-01', finished: '2020-06-04' }])
    expect(out.readsAdded).toBe(1)
    expect(windows(out.book)).toEqual([
      ['2020-06-01', '2020-06-04'],
      ['2025-01-01', '2025-01-05'],
    ])
    expect(out.book.cycles.map((c) => c.cycle)).toEqual([1, 2])
    expect(cycleDateSources(out.book.cycles[0])).toEqual({ started: 'storygraph', finished: 'storygraph' })
    expect(cycleDateSources(out.book.cycles[1])).toEqual({ started: 'bookwyrm', finished: 'bookwyrm' })
  })

  it('fills the finish of an open cycle, but leaves an abandoned one abandoned', () => {
    const open = mergeStorygraphReads(book('X', [cycle('2024-03-01', null)]), [{ started: '2024-03-01', finished: '2024-03-09' }])
    expect(day(open.book.finished)).toBe('2024-03-09')
    expect(open.finishesFilled).toBe(1)

    const dropped = mergeStorygraphReads(book('X', [cycle('2024-03-01', null, 1, '2024-03-05')]), [
      { started: '2024-03-01', finished: '2024-03-09' },
    ])
    expect(dropped.book.finished).toBeNull()
  })

  it('pairs each read with at most one cycle, closest first', () => {
    const out = mergeStorygraphReads(book('X', [cycle(null, '2024-03-10'), cycle(null, '2024-03-14', 2)]), [
      { started: '2024-03-08', finished: '2024-03-13' },
    ])
    // Paired with the 03-14 cycle (1 day), not the 03-10 one (3 days): that cycle takes
    // the start, keeps its own finish, and the other is left as it was.
    expect(windows(out.book)).toEqual([
      [null, '2024-03-10'],
      ['2024-03-08', '2024-03-14'],
    ])
    expect(out.conflicts[0]).toMatchObject({ field: 'finished', bookwyrm: '2024-03-14' })
  })

  it('refuses a finish that would land before BookWyrm\'s start', () => {
    const out = mergeStorygraphReads(book('X', [cycle('2024-03-10', null)]), [{ started: '2024-03-05', finished: '2024-03-08' }])
    expect(out.book.cycles[0].finished).toBeNull()
    expect(out.finishesFilled).toBe(0)
    expect(out.conflicts.map((c) => c.reason)).toEqual(['finish_before_start'])
  })

  it('is a no-op with no reads', () => {
    const b = book('X', [cycle(null, '2024-03-10')])
    expect(mergeStorygraphReads(b, []).book).toBe(b)
  })
})

describe('matchStorygraphBook', () => {
  const candidates: MatchCandidate[] = [
    { key: 'om udregning af rumfang i', url: 'https://bw/1', title: 'Om udregning af rumfang I', authors: ['Solvej Balle'], isbn13s: ['9788793718180'] },
    { key: 'om udregning af rumfang ii', url: 'https://bw/2', title: 'Om udregning af rumfang II', authors: ['Solvej Balle'], isbn13s: [] },
    { key: 'the left hand of darkness', url: 'https://bw/3', title: 'The Left Hand of Darkness', authors: ['Ursula K. Le Guin'], isbn13s: [] },
    { key: 'dune', url: 'https://bw/4', title: 'Dune', authors: ['Frank Herbert'], isbn13s: [] },
    { key: 'dune messiah', url: 'https://bw/5', title: 'Dune Messiah', authors: ['Frank Herbert'], isbn13s: [] },
  ]

  it('matches on ISBN-13 first', () => {
    expect(matchStorygraphBook({ title: 'Anything', authors: [], isbn13: '9788793718180' }, candidates)).toEqual({
      key: 'om udregning af rumfang i', url: 'https://bw/1', by: 'isbn',
    })
  })

  it('falls back to normalised title and author, without mixing up volumes', () => {
    expect(matchStorygraphBook({ title: 'Om Udregning af Rumfang II', authors: ['Solvej Balle'], isbn13: '9780000000002' }, candidates))
      .toMatchObject({ key: 'om udregning af rumfang ii', by: 'title_author' })
  })

  it('accepts a subtitle and a surname-only author agreement', () => {
    expect(matchStorygraphBook({ title: 'The Left Hand of Darkness: 50th Anniversary', authors: ['Ursula Le Guin'], isbn13: null }, candidates))
      .toMatchObject({ key: 'the left hand of darkness' })
  })

  it('prefers an exact title over a subtitle-stripped one', () => {
    expect(matchStorygraphBook({ title: 'Dune', authors: ['Frank Herbert'], isbn13: null }, candidates)).toMatchObject({ key: 'dune' })
  })

  it('never strips the BookWyrm subtitle: "Dune" does not land on "Dune: Messiah"', () => {
    const shelf: MatchCandidate[] = [
      { key: 'dune: messiah', url: null, title: 'Dune: Messiah', authors: ['Frank Herbert'], isbn13s: [] },
    ]
    expect(matchStorygraphBook({ title: 'Dune', authors: ['Frank Herbert'], isbn13: null }, shelf)).toBeNull()
  })

  it('does not take a shared surname with a different first name as the same author', () => {
    const shelf: MatchCandidate[] = [{ key: 'x', url: null, title: 'White Teeth', authors: ['Zadie Smith'], isbn13s: [] }]
    expect(matchStorygraphBook({ title: 'White Teeth', authors: ['John Smith'], isbn13: null }, shelf)).toBeNull()
  })

  it('needs the author to agree', () => {
    expect(matchStorygraphBook({ title: 'Dune', authors: ['Someone Else'], isbn13: null }, candidates)).toBeNull()
  })

  it('refuses an ambiguous title rather than guessing', () => {
    const twins: MatchCandidate[] = [
      { key: 'a', url: null, title: 'Collected Poems', authors: ['A Smith'], isbn13s: [] },
      { key: 'b', url: null, title: 'Collected Poems', authors: ['B Smith'], isbn13s: [] },
    ]
    expect(matchStorygraphBook({ title: 'Collected Poems', authors: ['C Smith'], isbn13: null }, twins)).toBeNull()
  })
})

describe('helpers', () => {
  it('normalizeMatchText folds diacritics and punctuation', () => {
    expect(normalizeMatchText('Kjærlighet & Krig — Bind 1!')).toBe('kjærlighet and krig bind 1')
    expect(normalizeMatchText('Café')).toBe('cafe')
  })
  it('collapseKey is the title key, else the url', () => {
    expect(collapseKey({ title: '  Ducks ', url: 'u' })).toBe('ducks')
    expect(collapseKey({ title: null, url: 'u' })).toBe('u')
  })
})
