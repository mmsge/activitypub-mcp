import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fillNamesFromLiveShelf, type NamedBook } from './book-identity.js'
import { fetchBookwyrmShelf } from './fetch-bookwyrm-shelf.js'

vi.mock('./fetch-bookwyrm-shelf.js', () => ({ fetchBookwyrmShelf: vi.fn() }))
const mockShelf = vi.mocked(fetchBookwyrmShelf)

const ACTOR = 'https://bookwyrm.social/user/mvrkws'
const shelfItem = (bookUrl: string, bookTitle: string, bookAuthor: string | null) => ({
  bookTitle, bookAuthor, bookCover: null, bookIsbn: null, bookUrl, shelvedDate: null, raw: {},
})

beforeEach(() => {
  mockShelf.mockReset()
})

describe('fillNamesFromLiveShelf', () => {
  it('does not fetch when every book with a URL already has a title', async () => {
    const books: NamedBook[] = [
      { url: 'https://bookwyrm.social/book/1', title: 'Known', author: null },
      { url: null, title: null, author: null }, // no URL — nothing to match on
    ]
    await fillNamesFromLiveShelf(ACTOR, books)
    expect(mockShelf).not.toHaveBeenCalled()
  })

  it('fills title and author for URL-only books from the live shelf', async () => {
    mockShelf.mockImplementation(async (_actor, shelf) =>
      shelf === 'read'
        ? [shelfItem('https://bookwyrm.social/book/1829511', "Carl's Doomsday Scenario", 'Matt Dinniman')]
        : [],
    )
    const books: NamedBook[] = [
      { url: 'https://bookwyrm.social/book/1829511', title: null, author: null },
      { url: 'https://bookwyrm.social/book/999', title: null, author: null }, // not on any shelf
    ]
    await fillNamesFromLiveShelf(ACTOR, books)
    expect(books[0]).toMatchObject({ title: "Carl's Doomsday Scenario", author: 'Matt Dinniman' })
    expect(books[1]).toMatchObject({ title: null, author: null })
    expect(mockShelf).toHaveBeenCalledTimes(3) // reading, read, to-read — once each
  })

  it('never overwrites an existing title or author', async () => {
    mockShelf.mockImplementation(async () => [
      shelfItem('https://bookwyrm.social/book/1', 'Shelf Title', 'Shelf Author'),
      shelfItem('https://bookwyrm.social/book/2', 'Other Title', 'Other Author'),
    ])
    const books: NamedBook[] = [
      { url: 'https://bookwyrm.social/book/1', title: 'Kept Title', author: 'Kept Author' },
      { url: 'https://bookwyrm.social/book/2', title: null, author: null }, // triggers the fetch
    ]
    await fillNamesFromLiveShelf(ACTOR, books)
    expect(books[0]).toMatchObject({ title: 'Kept Title', author: 'Kept Author' })
    expect(books[1]).toMatchObject({ title: 'Other Title', author: 'Other Author' })
  })
})
