import { describe, it, expect } from 'vitest'
import { mergeShelfWithDerived } from './actor-reading.js'
import { collapseReadingEvents, type DerivedReadingEvent, type ReadingEvent } from '../../lib/bookwyrm-reading.js'
import type { ShelfItem } from '../../lib/fetch-bookwyrm-shelf.js'

const shelfItem = (partial: Partial<ShelfItem>, shelf: 'reading' | 'read' | 'to-read') => ({
  bookTitle: null,
  bookAuthor: null,
  bookCover: null,
  bookIsbn: null,
  bookUrl: null,
  shelvedDate: null,
  raw: {},
  ...partial,
  shelf,
})

const derived = (
  partial: Partial<ReadingEvent> & { event_type: ReadingEvent['event_type'] },
  opts: { at?: string; rating?: string | null } = {},
): DerivedReadingEvent => ({
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
})

describe('mergeShelfWithDerived', () => {
  const collapsed = collapseReadingEvents([
    derived(
      { event_type: 'started_reading', book_title: 'Chanta', reading_status: 'reading', bookwyrm_book_url: 'https://b/book/1' },
      { at: '2026-05-01T10:00:00Z' },
    ),
    derived(
      { event_type: 'review', book_title: 'Chanta', bookwyrm_book_url: 'https://b/book/1', book_author: 'K. L. Kølleskov' },
      { at: '2026-05-12T10:00:00Z', rating: '4' },
    ),
  ])

  it('matches by Edition URL and fills derived dates + rating; live cover wins', () => {
    const [row] = mergeShelfWithDerived(
      [shelfItem({ bookTitle: 'Chanta', bookUrl: 'https://b/book/1', bookCover: 'https://b/c.jpg' }, 'read')],
      collapsed,
    )
    expect(row.started_date).toBe('2026-05-01')
    expect(row.finished_date).toBe('2026-05-12')
    expect(row.rating).toBe('4')
    expect(row.cover).toBe('https://b/c.jpg')
    expect(row.shelf).toBe('read')
  })

  it('falls back to a normalized-title match when the shelf URL differs', () => {
    const [row] = mergeShelfWithDerived(
      [shelfItem({ bookTitle: '  CHANTA ', bookUrl: 'https://b/book/other-edition' }, 'read')],
      collapsed,
    )
    expect(row.finished_date).toBe('2026-05-12')
  })

  it('leaves nulls when nothing matches, and surfaces shelved_date', () => {
    const [row] = mergeShelfWithDerived(
      [shelfItem({ bookTitle: 'Ukjent', bookUrl: 'https://b/book/9', shelvedDate: '2026-07-01T12:00:00Z' }, 'to-read')],
      collapsed,
    )
    expect(row.started_date).toBeNull()
    expect(row.finished_date).toBeNull()
    expect(row.rating).toBeNull()
    expect(row.shelved_date).toBe('2026-07-01')
  })

  it('fills author from derived data when the live shelf lacks it', () => {
    const [row] = mergeShelfWithDerived(
      [shelfItem({ bookTitle: 'Chanta', bookUrl: 'https://b/book/1' }, 'read')],
      collapsed,
    )
    expect(row.authors).toBe('K. L. Kølleskov')
  })
})
