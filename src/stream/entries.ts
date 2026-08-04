import type { Kind, Platform } from './sources.js'

/**
 * What the view layer renders. One shape per kind, discriminated on `kind`, so a
 * new entry type cannot be added without the renderer being made to handle it.
 *
 * Everything here is already safe to display: HTML has been sanitised, hidden and
 * deleted rows are gone, and only publishable entries got this far. The views do
 * no filtering of their own — a view that had to remember a privacy rule would
 * eventually forget it.
 */

export interface Attachment {
  url: string
  mediaType: string | null
  /** The author's own alt text, from the AP attachment's `name`. */
  alt: string | null
  width: number | null
  height: number | null
  blurhash: string | null
}

interface Base {
  refId: string
  eventAt: Date
  /** When this entered the archive — the feed's <updated>, never shown on the page. */
  archivedAt: Date
  source: Platform
  /** The post on its origin server. Every entry links out; none has a page here. */
  originUrl: string | null
}

export interface PostEntry extends Base {
  kind: 'post' | 'photo' | 'video'
  /** Sanitised HTML. */
  html: string
  /** Content warning; when set the body renders collapsed. */
  contentWarning: string | null
  sensitive: boolean
  language: string | null
  attachments: Attachment[]
  hashtags: string[]
  /** Later parts of one of Markus' own threads, in order. Empty for a lone post. */
  thread: Array<{ html: string; attachments: Attachment[]; originUrl: string | null }>
}

export interface BookEntry extends Base {
  kind: 'book_started' | 'book_finished' | 'book_review' | 'book_quote'
  title: string | null
  author: string | null
  coverUrl: string | null
  /** 0–5, as BookWyrm records it. */
  rating: number | null
  reviewTitle: string | null
  /** Sanitised HTML of the review or the surrounding commentary. */
  html: string | null
  quote: string | null
  pages: number | null
  pubYear: number | null
  series: string | null
  bookUrl: string | null
  contentWarning: string | null
}

export interface MarkEntry extends Base {
  kind: 'screen' | 'listen' | 'play' | 'read_neodb' | 'mark'
  title: string | null
  coverUrl: string | null
  category: string | null
  year: number | null
  /** Markus' own note on the mark, verbatim — never parsed or translated. */
  comment: string | null
  rating: number | null
  director: string | null
  genre: string[]
  itemUrl: string | null
}

export interface ScrobbleDayEntry extends Base {
  kind: 'scrobble_day'
  /** The Oslo day, YYYY-MM-DD. */
  day: string
  playCount: number
  topArtists: Array<{ artist: string; plays: number; imageUrl: string | null }>
  /** Every track of the day, for the expandable detail. */
  tracks: Array<{ track: string; artist: string; album: string | null; playedAt: Date }>
}

export interface TripEntry extends Base {
  kind: 'trip'
  fromStation: string
  toStation: string
  journey: string | null
  operator: string | null
  distanceKm: number | null
  mode: string | null
  night: boolean
}

export interface GardenEntry extends Base {
  kind: 'garden'
  title: string
  path: string
  excerpt: string | null
  tags: string[]
}

export type Entry = PostEntry | BookEntry | MarkEntry | ScrobbleDayEntry | TripEntry | GardenEntry

/** One page of the stream. */
export interface StreamPage {
  entries: Entry[]
  /** Token for the next page, or null at the end. */
  nextCursor: string | null
}

/** The four columns every lane emits, before hydration. */
export interface Candidate {
  eventAt: Date
  kind: Kind
  refId: string
  source: string
}
