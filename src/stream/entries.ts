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
  /**
   * The still frame for a video, from the attachment's `icon`.
   *
   * Null for most video anywhere: hardly any server sends one. A video with no poster
   * gets a text chip, never an `<img>` pointed at the video file — see Media.
   */
  posterUrl: string | null
  /** From the attachment's ISO-8601 `duration`. Null when the server sent none. */
  durationSeconds: number | null
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

/**
 * The train a post was written on, from the derived `trip_posts` join (ADR 0023).
 *
 * Never part of what the post said — the post carries no station, operator or
 * distance, and neither does the account it came from. This is worked out from
 * when it was published, so the view labels it as travel context rather than
 * folding it into the body.
 */
export interface PostTrip {
  relation: 'boarding' | 'aboard' | 'alighting'
  fromStation: string
  toStation: string
  journey: string | null
  /** URL segment for the journey page, or null when the trip carries no journey. */
  journeySlug: string | null
  operator: string | null
  distanceKm: number | null
  night: boolean
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
  /**
   * An embeddable player for this post on its origin, from the object's `preview`.
   *
   * Only ever framed on the reader's say-so — see Post. Null unless the origin
   * offered one, which today means Rullen.
   */
  embedUrl: string | null
  /** Later parts of one of Markus' own threads, in order. Empty for a lone post. */
  thread: Array<{ html: string; attachments: Attachment[]; originUrl: string | null }>
  /** The trip this was posted on, when it was. Null for the vast majority. */
  trip: PostTrip | null
}

export interface BookEntry extends Base {
  kind: 'book_started' | 'book_finished' | 'book_comment' | 'book_review' | 'book_quote'
  title: string | null
  /** The volume or edition line, where the catalogue carries one separately. */
  subtitle: string | null
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
  /** How far in the reader was, when BookWyrm carried a position. */
  progress: number | null
  /** The unit for `progress`: 'PG' for pages, 'PCT' for a percentage. */
  progressMode: string | null
  /**
   * The day this event closed the book, when it did.
   *
   * BookWyrm treats a review and a `read`-shelved comment as a finish without ever
   * emitting a "finished reading" note, so on those cards this is the only place a
   * reader can learn it happened. Set on a finish card too — it is a fact about the
   * event, not about the layout — and the view is what declines to print it there.
   */
  finishedAt: Date | null
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
  /**
   * The weather at the origin on the departure day — "🌧️ regn · 12°" — from
   * Open-Meteo's ERA5 archive (ADR 0028).
   *
   * Null far more often than not: the station may not be geocoded, the date may
   * still be inside the archive's lag, and the archive itself has gaps. A missing
   * value is a gap, never a zero, so the view omits the line rather than printing
   * one that reads like a measurement.
   */
  weather: string | null
}

export interface GardenEntry extends Base {
  kind: 'garden'
  title: string
  path: string
  excerpt: string | null
  tags: string[]
  /**
   * Where the date on this entry came from. `frontmatter` is what the note says
   * about itself; `bookwyrm` is recovered from the reading events of the book it
   * reviews, because the note carries no date of its own. The page says which, so
   * a derived date is never passed off as the note's own.
   */
  dateSource: 'frontmatter' | 'bookwyrm'
}

/** A published note with no date anywhere — listed, not placed in the stream. */
export interface UndatedGardenNote {
  title: string
  path: string
  url: string
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
