import { describe, it, expect } from 'vitest'
import {
  classifyReadingEvent,
  collapseReadingEvents,
  deriveReadingCycles,
  indexCollapsedBooks,
  normalizeTitle,
  normalizeReadingStatus,
  type ReadingEvent,
  type DerivedReadingEvent,
} from './bookwyrm-reading.js'

const AP = 'https://bookwyrm.social/user/mvrkws'

// Convenience builder for a classified event going into the collapse.
function derived(
  partial: Partial<ReadingEvent> & { event_type: ReadingEvent['event_type'] },
  opts: { at?: string; rating?: string | null } = {},
): DerivedReadingEvent {
  return {
    event: {
      book_title: null,
      book_author: null,
      bookwyrm_book_url: null,
      comment: null,
      reading_status: null,
      quote: null,
      review_title: null,
      progress: null,
      progress_mode: null,
      ...partial,
    },
    publishedAt: opts.at ? new Date(opts.at) : null,
    rating: opts.rating ?? null,
  }
}

describe('normalizeTitle', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeTitle('  Paper   Girls ')).toBe('paper girls')
  })
  it('returns empty string for null/whitespace', () => {
    expect(normalizeTitle(null)).toBe('')
    expect(normalizeTitle('   ')).toBe('')
  })
})

describe('classifyReadingEvent — event_type by ap_id segment + content', () => {
  it('classifies a started-reading generatednote', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/generatednote/1`,
      content: 'mvrkws started reading Chanta',
      tags: [],
      attachments: [],
    })
    expect(ev?.event_type).toBe('started_reading')
    expect(ev?.book_title).toBe('Chanta')
  })

  it('classifies finished / shelved / note generatednotes', () => {
    const finished = classifyReadingEvent({
      apId: `${AP}/generatednote/2`,
      content: 'mvrkws finished reading Paper Girls',
      tags: [],
      attachments: [],
    })
    const shelved = classifyReadingEvent({
      apId: `${AP}/generatednote/3`,
      content: 'mvrkws wants to read Ducks',
      tags: [],
      attachments: [],
    })
    const note = classifyReadingEvent({
      apId: `${AP}/generatednote/4`,
      content: 'mvrkws set a goal to read 50 books',
      tags: [],
      attachments: [],
    })
    expect(finished?.event_type).toBe('finished_reading')
    expect(shelved?.event_type).toBe('shelved')
    expect(note?.event_type).toBe('note')
  })

  it('classifies comment / review / rating segments', () => {
    expect(classifyReadingEvent({ apId: `${AP}/comment/5`, content: 'nice', tags: [], attachments: [] })?.event_type).toBe('comment')
    expect(classifyReadingEvent({ apId: `${AP}/review/6`, content: 'great', tags: [], attachments: [] })?.event_type).toBe('review')
    expect(classifyReadingEvent({ apId: `${AP}/rating/7`, content: null, tags: [], attachments: [] })?.event_type).toBe('rating')
  })

  it('returns null for a non-reading Note', () => {
    expect(classifyReadingEvent({ apId: `${AP}/status/8`, content: 'hello', tags: [], attachments: [] })).toBeNull()
  })
})

describe('classifyReadingEvent — book metadata extraction precedence', () => {
  it('prefers the Edition tag (title + url)', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/10`,
      content: 'loved it',
      tags: [{ type: 'Edition', name: '@Chanta', href: 'https://bookwyrm.social/book/2330651' }],
      attachments: [{ name: 'Someone Else: Wrong Title (Paperback)' }],
    })
    expect(ev?.book_title).toBe('Chanta')
    expect(ev?.bookwyrm_book_url).toBe('https://bookwyrm.social/book/2330651')
  })

  it('falls back to attachment "Author: Title (…)" when no Edition tag', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/11`,
      content: 'thoughts',
      tags: [],
      attachments: [{ name: 'Matt Dinniman: Dungeon Anarchist’s Cookbook (Paperback, 2021, Ace)' }],
    })
    expect(ev?.book_author).toBe('Matt Dinniman')
    expect(ev?.book_title).toBe('Dungeon Anarchist’s Cookbook')
    expect(ev?.bookwyrm_book_url).toBeNull()
  })

  it('falls back to the content regex for the title only', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/generatednote/12`,
      content: 'mvrkws started reading Hysj.',
      tags: [],
      attachments: [],
    })
    expect(ev?.book_title).toBe('Hysj')
  })

  it('carries comment/review body, not other types', () => {
    expect(classifyReadingEvent({ apId: `${AP}/review/13`, content: 'a review', tags: [], attachments: [] })?.comment).toBe('a review')
    expect(classifyReadingEvent({ apId: `${AP}/generatednote/14`, content: 'started reading X', tags: [], attachments: [] })?.comment).toBeNull()
  })
})

describe('collapseReadingEvents — one row per book', () => {
  it('merges a title-only comment with a url-bearing started event into one row', () => {
    const books = collapseReadingEvents([
      // comment with no Edition tag → title only, no url, no shelf
      derived({ event_type: 'comment', book_title: 'Chanta', book_author: 'K. L. Kølleskov' }, { at: '2026-06-21T00:00:00Z' }),
      // started generatednote with Edition tag → url + shelf
      derived(
        { event_type: 'started_reading', book_title: 'Chanta', bookwyrm_book_url: 'https://bookwyrm.social/book/2330651' },
        { at: '2026-06-20T00:00:00Z' },
      ),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBe('reading')
    expect(books[0].url).toBe('https://bookwyrm.social/book/2330651')
    expect(books[0].started?.toISOString().slice(0, 10)).toBe('2026-06-20')
    expect(books[0].author).toBe('K. L. Kølleskov')
  })

  it('collapses started → finished into shelf=read with both dates', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'finished_reading', book_title: 'Paper Girls', bookwyrm_book_url: 'u' }, { at: '2026-06-20T00:00:00Z' }),
      derived({ event_type: 'started_reading', book_title: 'Paper Girls', bookwyrm_book_url: 'u' }, { at: '2026-06-14T00:00:00Z' }),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBe('read')
    expect(books[0].started?.toISOString().slice(0, 10)).toBe('2026-06-14')
    expect(books[0].finished?.toISOString().slice(0, 10)).toBe('2026-06-20')
  })

  it('the most recent shelf-changing event wins regardless of input order', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'started_reading', book_title: 'X', bookwyrm_book_url: 'x' }, { at: '2026-02-10T00:00:00Z' }),
      derived({ event_type: 'shelved', book_title: 'X', bookwyrm_book_url: 'x' }, { at: '2026-01-01T00:00:00Z' }),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBe('reading') // started (Feb) is newer than shelved (Jan)
  })

  it('carries a rating forward and never blanks it on a later event that lacks one', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'comment', book_title: 'Rated', bookwyrm_book_url: 'r' }, { at: '2026-03-02T00:00:00Z', rating: null }),
      derived({ event_type: 'review', book_title: 'Rated', bookwyrm_book_url: 'r' }, { at: '2026-03-01T00:00:00Z', rating: '4.5' }),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].rating).toBe('4.5')
  })

  it('keeps comment-only books (no shelf event) as a single row with shelf null', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'comment', book_title: 'Ducks', book_author: 'Kate Beaton' }, { at: '2026-05-01T00:00:00Z' }),
      derived({ event_type: 'comment', book_title: 'Ducks' }, { at: '2026-05-02T00:00:00Z' }),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBeNull()
    expect(books[0].title).toBe('Ducks')
  })

  it('skips events with neither title nor url', () => {
    const books = collapseReadingEvents([derived({ event_type: 'note' }, { at: '2026-01-01T00:00:00Z' })])
    expect(books).toHaveLength(0)
  })

  it('treats a "read" comment as a finish (the BookWyrm "leste ferdig" case)', () => {
    // A comment carrying readingStatus="read" is how BookWyrm marks a finish when
    // no standalone finished_reading generatednote is produced.
    const books = collapseReadingEvents([
      derived(
        { event_type: 'comment', book_title: 'Dungeon Anarchist’s Cookbook', bookwyrm_book_url: 'd', reading_status: 'read' },
        { at: '2026-06-22T08:48:25Z' },
      ),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBe('read')
    expect(books[0].finished?.toISOString().slice(0, 10)).toBe('2026-06-22')
  })

  it('a "reading" comment marks started/shelf=reading, not finished', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'comment', book_title: 'X', bookwyrm_book_url: 'x', reading_status: 'reading' }, { at: '2026-02-01T00:00:00Z' }),
    ])
    expect(books[0].shelf).toBe('reading')
    expect(books[0].started?.toISOString().slice(0, 10)).toBe('2026-02-01')
    expect(books[0].finished).toBeNull()
  })
})

describe('classifyReadingEvent — readingStatus field', () => {
  it('keeps event_type as comment but surfaces reading_status=read', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/99`,
      content: 'done (comment on Foo)',
      tags: [{ type: 'Edition', name: '@Foo', href: 'https://bookwyrm.social/book/1' }],
      attachments: [],
      readingStatus: 'read',
    })
    expect(ev?.event_type).toBe('comment')
    expect(ev?.reading_status).toBe('read')
  })

  it('takes the book url from inReplyToBook when there is no Edition tag (comment case)', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/100`,
      content: 'Så mange tog! (comment on Dungeon Anarchist’s Cookbook)',
      tags: [{ type: 'Hashtag', name: '#TogTut' }],
      attachments: [{ name: 'Matt Dinniman: Dungeon Anarchist’s Cookbook (Hardcover, 2025)' }],
      readingStatus: 'read',
      inReplyToBook: 'https://bookwyrm.social/book/2308638',
    })
    expect(ev?.bookwyrm_book_url).toBe('https://bookwyrm.social/book/2308638')
    expect(ev?.reading_status).toBe('read')
    expect(ev?.book_author).toBe('Matt Dinniman')
  })

  it('normalizes a shelf-URL readingStatus and tolerates absent value', () => {
    expect(normalizeReadingStatus('https://bookwyrm.social/user/x/shelf/to-read')).toBe('to-read')
    expect(normalizeReadingStatus('read')).toBe('read')
    expect(normalizeReadingStatus(undefined)).toBeNull()
  })
})

describe('classifyReadingEvent — quotation', () => {
  it('classifies a /quotation/ segment and strips the quote HTML', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/quotation/1`,
      content: '"To be or not to be" — Hamlet, min kommentar',
      tags: [],
      attachments: [],
      quote: '<p>To be or not to be</p>',
      readingStatus: 'reading',
      inReplyToBook: 'https://bookwyrm.social/book/42',
    })
    expect(ev?.event_type).toBe('quotation')
    expect(ev?.quote).toBe('To be or not to be')
    expect(ev?.comment).toContain('min kommentar')
    expect(ev?.bookwyrm_book_url).toBe('https://bookwyrm.social/book/42')
    expect(ev?.reading_status).toBe('reading')
  })

  it('leaves quote null on non-quotation events even if raw carried one', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/2`,
      content: 'a comment',
      tags: [],
      attachments: [],
      quote: '<p>stray</p>',
    })
    expect(ev?.quote).toBeNull()
  })
})

describe('classifyReadingEvent — review title and progress', () => {
  it('surfaces the review title from the AP name field', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/review/3`,
      content: 'body',
      tags: [],
      attachments: [],
      name: 'Review of "Chanta" (5 stars)',
    })
    expect(ev?.review_title).toBe('Review of "Chanta" (5 stars)')
  })

  it('parses progress as a number and carries progress_mode', () => {
    const ev = classifyReadingEvent({
      apId: `${AP}/comment/4`,
      content: 'halfway!',
      tags: [],
      attachments: [],
      progress: '150',
      progressMode: 'PG',
    })
    expect(ev?.progress).toBe(150)
    expect(ev?.progress_mode).toBe('PG')
  })

  it('leaves progress null for absent or junk values', () => {
    const none = classifyReadingEvent({ apId: `${AP}/comment/5`, content: 'x', tags: [], attachments: [] })
    const junk = classifyReadingEvent({ apId: `${AP}/comment/6`, content: 'x', tags: [], attachments: [], progress: 'abc' })
    expect(none?.progress).toBeNull()
    expect(junk?.progress).toBeNull()
  })
})

describe('collapseReadingEvents — review as finish + cycle-derived dates', () => {
  it('a review finishes the book (shelf=read, finished = review date)', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'started_reading', book_title: 'Chanta', reading_status: 'reading' }, { at: '2026-05-01T10:00:00Z' }),
      derived({ event_type: 'review', book_title: 'Chanta' }, { at: '2026-05-10T10:00:00Z', rating: '4' }),
    ])
    expect(books).toHaveLength(1)
    expect(books[0].shelf).toBe('read')
    expect(books[0].started?.toISOString().slice(0, 10)).toBe('2026-05-01')
    expect(books[0].finished?.toISOString().slice(0, 10)).toBe('2026-05-10')
    expect(books[0].rating).toBe('4')
  })

  it('a post-finish comment does not drag the finish date later', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'comment', book_title: 'Foo', reading_status: 'reading' }, { at: '2026-07-11T10:00:00Z' }),
      derived({ event_type: 'comment', book_title: 'Foo', reading_status: 'read' }, { at: '2026-07-20T10:00:00Z' }),
      derived({ event_type: 'comment', book_title: 'Foo', reading_status: 'read' }, { at: '2026-07-25T10:00:00Z' }),
    ])
    expect(books[0].finished?.toISOString().slice(0, 10)).toBe('2026-07-20')
    expect(books[0].cycles).toHaveLength(1)
  })

  it('a reread produces two cycles; collapsed dates span first start → last finish', () => {
    const books = collapseReadingEvents([
      derived({ event_type: 'started_reading', book_title: 'Dune', reading_status: 'reading' }, { at: '2024-01-01T00:00:00Z' }),
      derived({ event_type: 'finished_reading', book_title: 'Dune', reading_status: 'read' }, { at: '2024-01-20T00:00:00Z' }),
      derived({ event_type: 'started_reading', book_title: 'Dune', reading_status: 'reading' }, { at: '2026-06-01T00:00:00Z' }),
      derived({ event_type: 'finished_reading', book_title: 'Dune', reading_status: 'read' }, { at: '2026-06-15T00:00:00Z' }),
    ])
    expect(books[0].cycles).toHaveLength(2)
    expect(books[0].cycles[1].cycle).toBe(2)
    expect(books[0].started?.toISOString().slice(0, 10)).toBe('2024-01-01')
    expect(books[0].finished?.toISOString().slice(0, 10)).toBe('2026-06-15')
  })
})

describe('deriveReadingCycles', () => {
  const ev = (
    type: ReadingEvent['event_type'],
    rs: 'read' | 'reading' | 'to-read' | null,
    at: string,
  ): DerivedReadingEvent =>
    derived({ event_type: type, book_title: 'B', reading_status: rs }, { at })

  it('derives a single start→finish cycle', () => {
    const cycles = deriveReadingCycles([
      ev('started_reading', 'reading', '2026-01-01T00:00:00Z'),
      ev('finished_reading', 'read', '2026-01-10T00:00:00Z'),
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].started?.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(cycles[0].finished?.toISOString().slice(0, 10)).toBe('2026-01-10')
  })

  it('progress comments while reading do not reset the start', () => {
    const cycles = deriveReadingCycles([
      ev('started_reading', 'reading', '2026-01-01T00:00:00Z'),
      ev('comment', 'reading', '2026-01-05T00:00:00Z'),
      ev('finished_reading', 'read', '2026-01-10T00:00:00Z'),
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].started?.toISOString().slice(0, 10)).toBe('2026-01-01')
  })

  it('a finish with no recorded start is a finish-only cycle; later re-affirmations are ignored', () => {
    const cycles = deriveReadingCycles([
      ev('comment', 'read', '2026-02-01T00:00:00Z'),
      ev('comment', 'read', '2026-02-10T00:00:00Z'),
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].started).toBeNull()
    expect(cycles[0].finished?.toISOString().slice(0, 10)).toBe('2026-02-01')
  })

  it('an unfinished current read is an open cycle', () => {
    const cycles = deriveReadingCycles([
      ev('finished_reading', 'read', '2025-01-10T00:00:00Z'),
      ev('started_reading', 'reading', '2026-03-01T00:00:00Z'),
    ])
    expect(cycles).toHaveLength(2)
    expect(cycles[1].started?.toISOString().slice(0, 10)).toBe('2026-03-01')
    expect(cycles[1].finished).toBeNull()
  })

  it('events without a publish time are skipped', () => {
    const cycles = deriveReadingCycles([
      derived({ event_type: 'started_reading', book_title: 'B', reading_status: 'reading' }),
    ])
    expect(cycles).toHaveLength(0)
  })
})

describe('indexCollapsedBooks', () => {
  it('indexes by both url and normalized title', () => {
    const books = collapseReadingEvents([
      derived(
        { event_type: 'started_reading', book_title: 'Paper Girls', reading_status: 'reading', bookwyrm_book_url: 'https://b/book/1' },
        { at: '2026-01-01T00:00:00Z' },
      ),
    ])
    const index = indexCollapsedBooks(books)
    expect(index.get('https://b/book/1')?.title).toBe('Paper Girls')
    expect(index.get('paper girls')?.title).toBe('Paper Girls')
  })
})
