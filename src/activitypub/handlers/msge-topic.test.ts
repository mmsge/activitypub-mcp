import { describe, it, expect } from 'vitest'
import { msgeTopicFor } from './create.js'

// Which of msge.no's surfaces an ingested object feeds. Pure, so it is testable
// without a database or a delivery — and worth testing, because getting it wrong is
// silent: the wrong poller wakes, the right page stays stale for six hours, and
// nothing anywhere reports an error.

const mark = (itemUrl: string) => ({
  type: 'Note',
  relatedWith: { type: 'Status', status: 'complete', withRegardTo: itemUrl },
})
const neodbTag = (href: string) => [{ type: 'Edition', href }]

describe('msgeTopicFor', () => {
  it('sends BookWyrm objects to the bookcase', () => {
    for (const type of ['Edition', 'Review', 'Rating', 'Comment', 'Quotation', 'ReadThrough']) {
      expect(msgeTopicFor(type, { type })).toBe('bok')
    }
  })

  it('sends a NeoDB film mark to the poster wall', () => {
    const obj = mark('https://neodb.social/movie/abc123')
    expect(msgeTopicFor('Note', obj, [{ type: 'Movie', href: 'https://neodb.social/movie/abc123' }]))
      .toBe('film')
  })

  it('sends a NeoDB BOOK mark to the bookcase, not the poster wall', () => {
    // The trap. /film is built from /watched, which is film and TV — a book mark
    // routed there wakes a poller that will never show it, and leaves /bokhylla
    // waiting out its own six hours.
    const url = 'https://neodb.social/book/aBc123'
    expect(msgeTopicFor('Note', mark(url), neodbTag(url))).toBe('bok')
  })

  it('treats a BookWyrm-shaped /book/ id as not-NeoDB', () => {
    // BookWyrm book ids are digits; NeoDB's base62 ids carry letters. A digits-only
    // id is a BookWyrm URL that happens to sit under /book/, so it is not a NeoDB
    // book mark and must not be routed as one.
    const url = 'https://bookwyrm.social/book/12345'
    expect(msgeTopicFor('Note', mark(url), neodbTag(url))).toBe('film')
  })

  it('sends an ordinary post to the post surfaces', () => {
    // `tut` covers the togselfie gallery, the engagement board AND the photo
    // gallery on msge.no's side, so a Pixelfed upload needs no special case here.
    expect(msgeTopicFor('Note', { type: 'Note', content: 'hei' })).toBe('tut')
  })

  it('sends an image post to the post surfaces, not a photo-only topic', () => {
    const obj = {
      type: 'Note',
      content: '#togselfie',
      attachment: [{ type: 'Image', url: 'https://x/1.jpg' }],
    }
    expect(msgeTopicFor('Note', obj)).toBe('tut')
  })

  it('parks gig attendances on tut until msge.no grows a gig page', () => {
    // Deliberate: inventing a `konsert` topic nothing listens to would be a wake
    // that always 400s. Change this the day /konsertar exists.
    const obj = { type: 'Note', tag: [{ type: 'Link', name: 'Konsert', href: 'https://gigowl.social/gig/1' }] }
    expect(msgeTopicFor('Note', obj)).toBe('tut')
  })
})
