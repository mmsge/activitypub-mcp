import { describe, it, expect } from 'vitest'
import {
  classifyReadingEvent,
  collapseReadingEvents,
  normalizeTitle,
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
})
