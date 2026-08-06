import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { normalizeReadingStatus } from '../lib/bookwyrm-reading.js'
import {
  streamReadingKind, readingStatusOn, readingKindCaseOn, meaningfulReadingOn,
  type StreamReadingRow,
} from './reading-events.js'

const dialect = new PgDialect()

/** The query text alone — for anything about the shape or the order of the arms. */
const renderSql = (s: unknown): string => dialect.sqlToQuery(s as never).sql

/**
 * The query text with its bound values appended.
 *
 * The segments and phrases are parameters, not literals, so a test that read the
 * SQL alone would see `$3` and pass whatever was actually matched. Anything
 * asserting *what* is selected has to look here — but nothing may assert on
 * position, since the params are all at the end.
 */
const render = (s: unknown): string => {
  const q = dialect.sqlToQuery(s as never)
  return `${q.sql}\n-- params: ${JSON.stringify(q.params)}`
}

/** An `objects` row, named the way BookWyrm names them. */
const row = (apId: string, partial: Partial<StreamReadingRow> = {}): StreamReadingRow => ({
  apId,
  contentText: null,
  readingStatus: null,
  ...partial,
})

const AP = {
  note: 'https://bookwyrm.social/user/mvrkws/generatednote/12091719',
  comment: 'https://bookwyrm.social/user/mvrkws/comment/12215917',
  review: 'https://bookwyrm.social/user/mvrkws/review/7609066',
  rating: 'https://bookwyrm.social/user/mvrkws/reviewrating/3877264',
  quotation: 'https://bookwyrm.social/user/mvrkws/quotation/9452950',
}

describe('streamReadingKind', () => {
  describe('a shelf flip that arrives as its own note', () => {
    it('reads "started reading" as a start', () => {
      expect(streamReadingKind(row(AP.note, { contentText: 'Markus started reading This Inevitable Ruin' })))
        .toBe('book_started')
    })

    it('reads "finished reading" as a finish', () => {
      expect(streamReadingKind(row(AP.note, { contentText: 'Markus finished reading Heartstopper' })))
        .toBe('book_finished')
    })

    // Long-standing behaviour, kept deliberately: a book opened and closed the same
    // day produces one note naming both verbs, and it has always shown as the start.
    // The rule order puts finishes first, so without the guard every such card flips.
    it('reads a note naming both verbs as the start', () => {
      expect(streamReadingKind(row(AP.note, {
        contentText: 'Markus started reading and finished reading Kort dag',
      }))).toBe('book_started')
    })

    it('keeps "wants to read" off the page — intent is not activity', () => {
      expect(streamReadingKind(row(AP.note, { contentText: 'Markus wants to read Kongen' })))
        .toBeNull()
    })

    it('treats a reading-goal note as a remark, not as a start', () => {
      expect(streamReadingKind(row(AP.note, { contentText: 'Markus has set a goal of reading 50 books' })))
        .toBe('book_comment')
    })

    it('survives a note with no text at all', () => {
      expect(streamReadingKind(row(AP.note))).toBe('book_comment')
    })
  })

  describe('a shelf flip that arrives as a comment', () => {
    // The bug. BookWyrm emits no generatednote when the modal carried a sentence,
    // so these four were the events that vanished from Markus' own timeline.
    it('start via comment: a "reading" comment is a start, not chatter', () => {
      expect(streamReadingKind(row(AP.comment, {
        contentText: 'Siste bok for no!', readingStatus: 'reading',
      }))).toBe('book_started')
    })

    it('finish via comment: a "read" comment is a finish', () => {
      expect(streamReadingKind(row(AP.comment, {
        contentText: 'markus.plus/melding/bok/this-inevitable-ruin', readingStatus: 'read',
      }))).toBe('book_finished')
    })

    it('mid-read comment: no shelf state means a plain remark', () => {
      expect(streamReadingKind(row(AP.comment, { contentText: 'Pause frå Carl' })))
        .toBe('book_comment')
    })

    it('keeps a to-read comment off the page, like the note it stands in for', () => {
      expect(streamReadingKind(row(AP.comment, {
        contentText: 'Denne må eg lesa', readingStatus: 'to-read',
      }))).toBeNull()
    })

    it('reads the shelf URL form the same as the bare word', () => {
      const shelf = (s: string) => streamReadingKind(row(AP.comment, { readingStatus: s }))
      expect(shelf('https://bookwyrm.social/user/mvrkws/books/reading')).toBe('book_started')
      expect(shelf('https://bookwyrm.social/user/mvrkws/books/read')).toBe('book_finished')
      expect(shelf('https://bookwyrm.social/user/mvrkws/books/to-read')).toBeNull()
    })
  })

  describe('the posts that keep their own card whatever the shelf says', () => {
    it('review that is also a finish stays a review', () => {
      expect(streamReadingKind(row(AP.review, { contentText: 'Sterk.', readingStatus: 'read' })))
        .toBe('book_review')
    })

    it('a bare rating renders as a review card, stars and nothing else', () => {
      expect(streamReadingKind(row(AP.rating))).toBe('book_review')
    })

    it('finds a rating at /reviewrating/, which is where BookWyrm actually puts it', () => {
      // The trap, and it hid for the life of the module: the segment read
      // '/rating/', which cannot match '/reviewrating/' because the character
      // before "rating" is a "w". Four real ratings sat unclassified, and the
      // MCP's `event_type: 'rating'` filter could only ever return nothing —
      // because the test that should have caught it asserted the invented shape.
      const AT = 'https://bookwyrm.social/user/mvrkws'
      expect(streamReadingKind(row(`${AT}/reviewrating/3877264`))).toBe('book_review')
      expect(streamReadingKind(row(`${AT}/rating/3877264`))).toBeNull()
      // And it must not swallow, or be swallowed by, a review.
      expect(streamReadingKind(row(`${AT}/review/7609066`))).toBe('book_review')
    })

    it('quotation that is also a finish stays a quotation', () => {
      expect(streamReadingKind(row(AP.quotation, { contentText: 'Heh', readingStatus: 'read' })))
        .toBe('book_quote')
    })
  })

  it('refuses an ap_id shape it has not been taught', () => {
    // Selecting positively is the point: a new BookWyrm post type waits to be
    // understood rather than arriving on the page unannounced.
    expect(streamReadingKind(row('https://bookwyrm.social/user/mvrkws/reactivity/1'))).toBeNull()
  })
})

describe('readingStatusOn mirrors normalizeReadingStatus', () => {
  // The two implementations of one rule. The words nest — "to-read" contains
  // "read", "reading" contains "read" — so the ordering is the whole difficulty,
  // and it is written out twice in two languages.
  const CASES = [
    'read', 'reading', 'to-read', 'want-to-read', '',
    'https://bookwyrm.social/user/mvrkws/books/read',
    'https://bookwyrm.social/user/mvrkws/books/reading',
    'https://bookwyrm.social/user/mvrkws/books/to-read',
  ]

  /** What the SQL would answer, evaluated the way Postgres evaluates the LIKEs. */
  const bySql = (value: string): string | null => {
    const s = value.toLowerCase()
    const toRead = s.includes('to-read') || s.includes('want-to-read')
    const reading = !toRead && s.includes('reading')
    const read = !toRead && !reading && s.includes('read')
    if (toRead) return 'to-read'
    if (reading) return 'reading'
    if (read) return 'read'
    return null
  }

  for (const value of CASES) {
    it(`agrees on ${value || '(empty)'}`, () => {
      expect(bySql(value)).toBe(normalizeReadingStatus(value))
    })
  }

  it('reads the column through lower(coalesce(…)), so NULL is not a match', () => {
    const sql = render(readingStatusOn('o', 'read'))
    expect(sql).toContain("lower(coalesce(o.raw->>'readingStatus', ''))")
  })

  it('excludes the shelves whose names it contains', () => {
    expect(render(readingStatusOn('o', 'read'))).toContain('NOT')
    expect(render(readingStatusOn('o', 'reading'))).toContain('NOT')
    // to-read is the outermost test and has nothing to exclude.
    expect(render(readingStatusOn('o', 'to-read'))).not.toContain('NOT')
  })
})

describe('the SQL and the predicate select the same set', () => {
  it('names every kind the predicate can return, and no other', () => {
    const sql = render(readingKindCaseOn('o'))
    for (const kind of ['book_review', 'book_quote', 'book_finished', 'book_started', 'book_comment']) {
      expect(sql, kind).toContain(kind)
    }
  })

  it('tests the verdicts before the shelf state, as the predicate does', () => {
    // The ordering is the design: a review that also closes the book is a review.
    const sql = renderSql(readingKindCaseOn('o'))
    expect(sql.indexOf("'book_review'")).toBeLessThan(sql.indexOf("'book_quote'"))
    expect(sql.indexOf("'book_quote'")).toBeLessThan(sql.indexOf("'book_finished'"))
    expect(sql.indexOf("'book_finished'")).toBeLessThan(sql.indexOf("'book_started'"))
    expect(sql.indexOf("'book_started'")).toBeLessThan(sql.indexOf("'book_comment'"))
  })

  it('gates on the same segments the predicate recognises', () => {
    const sql = render(meaningfulReadingOn('o'))
    for (const seg of ['/review/', '/reviewrating/', '/quotation/', '/comment/', '/generatednote/']) {
      expect(sql, seg).toContain(seg)
    }
    expect(sql).toContain('wants to read')
  })
})

describe('an alias is never interpolated unchecked', () => {
  // These build raw SQL by string concatenation, so the alias is the one place an
  // injection could get in.
  for (const bad of ['o; DROP TABLE objects', 'O', '1o', '']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => readingStatusOn(bad, 'read')).toThrow(/alias/i)
      expect(() => meaningfulReadingOn(bad)).toThrow(/alias/i)
    })
  }
})
