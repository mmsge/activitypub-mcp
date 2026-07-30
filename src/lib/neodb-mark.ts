// Parsing a NeoDB "mark" out of a federated ActivityPub `Note`.
//
// NeoDB (minreol.dk, neodb.social, …) publishes each watch/read/shelve as a plain
// `Note` carrying its Mastodon-compatible `status` extension. The two structured hooks
// that identify a mark — and which we work off exclusively, never the prose in
// `content` — are:
//
//   relatedWith: { type:'Status', status:<verb>, withRegardTo:<catalog url>,
//                  published, updated, … }
//   tag:         { type:'Movie'|'TVSeason'|'Edition'|…, href:<catalog url>, name, image }
//
// `relatedWith` is a SINGLE object for a bare mark but an ARRAY when the mark carries
// more than one related record — a mark made with a comment federates as
// [{type:'Status', …}, {type:'Comment', content:'…', …}]. Both shapes are normalised
// here; treating only the object shape as a mark is what once made every commented
// mark invisible to the store.
//
// Everything here is pure (no DB, no network) so it unit-tests on the verified live
// payload. The DB upsert/tombstone live in jobs/sync-neodb-marks.ts.

type AnyObject = Record<string, unknown>

// NeoDB's shelf vocabulary → the canonical status token we store. NeoDB's own verbs are
// already clean, so the map is mostly identity; its job is to (a) enumerate the KNOWN set
// so an unknown verb can be flagged for a debug log and (b) give one place to remap if a
// future verb needs collapsing. Semantics per category: wishlist = to-watch / to-read,
// progress = watching / reading, complete = watched / read, dropped = dropped.
export const MARK_STATUS_MAP: Record<string, string> = {
  wishlist: 'wishlist',
  progress: 'progress',
  complete: 'complete',
  dropped: 'dropped',
}

// Map a NeoDB shelf verb to { status, raw, known }. An unknown verb is kept verbatim
// (lowercased/trimmed) rather than dropped, and flagged so the caller can log at debug —
// the store must never crash on a vocabulary NeoDB adds later.
export function mapMarkStatus(verb: unknown): { status: string | null; raw: string | null; known: boolean } {
  const raw = typeof verb === 'string' && verb.trim() ? verb.trim() : null
  if (!raw) return { status: null, raw: null, known: false }
  const key = raw.toLowerCase()
  const mapped = MARK_STATUS_MAP[key]
  return { status: mapped ?? key, raw, known: mapped != null }
}

// AP tag type → NeoDB category. Mirrors the categories NeoDB enrichment writes to
// catalog_metadata.category, so a mark and its enriched catalogue row agree on `category`.
// Books federate as `Edition` (shared with BookWyrm); NeoDB vs BookWyrm editions are told
// apart by URL shape downstream — here an Edition is simply a book.
export const TYPE_TO_CATEGORY: Record<string, string> = {
  Movie: 'movie',
  TVShow: 'tv',
  TVSeason: 'tv',
  TVEpisode: 'tv',
  Edition: 'book',
  Book: 'book',
  Album: 'music',
  Game: 'game',
  Podcast: 'podcast',
  Performance: 'performance',
  PerformanceProduction: 'performance',
}

export function mapItemTypeToCategory(itemType: unknown): string | null {
  if (typeof itemType !== 'string') return null
  return TYPE_TO_CATEGORY[itemType] ?? null
}

// Canonicalise a NeoDB catalog URL so `withRegardTo`, the media `tag.href`, and the
// `~neodb~` link embedded in the prose all collapse to a single key: drop a `/~neodb~`
// path segment and any trailing slash. This must match how catalog_metadata keys its
// rows (the bare tag href) so the mark joins onto its enriched title.
export function normalizeItemUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  try {
    const u = new URL(s)
    u.hash = ''
    u.search = ''
    u.pathname = u.pathname.replace(/\/~neodb~(?=\/)/, '').replace(/\/+$/, '')
    return u.toString()
  } catch {
    return s.replace('/~neodb~/', '/').replace(/\/+$/, '')
  }
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// The origin-local post id from a mark URL, e.g. `.../posts/600189802906904872/` →
// "600189802906904872"; falls back to the last path segment.
function extractPostId(url: string | null): string | null {
  if (!url) return null
  const m = /\/posts\/([^/?#]+)/.exec(url)
  if (m) return m[1]
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    return segs.length ? segs[segs.length - 1] : null
  } catch {
    return null
  }
}

function toTagArray(v: unknown): AnyObject[] {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.filter((t): t is AnyObject => !!t && typeof t === 'object')
}

// Pick the catalogue tag for a mark: prefer the one whose href resolves to the mark's
// item URL, else the first NeoDB media-type tag, else the first tag. Robust to `tag`
// being a single object (NeoDB's shape) or an array (Mastodon-style).
function pickNeodbTag(tag: unknown, itemUrl: string): AnyObject | null {
  const tags = toTagArray(tag)
  if (tags.length === 0) return null
  const byHref = tags.find((t) => normalizeItemUrl(t.href) === itemUrl)
  if (byHref) return byHref
  const media = tags.find((t) => typeof t.type === 'string' && TYPE_TO_CATEGORY[t.type as string])
  return media ?? tags[0]
}

// `relatedWith` normalised to an array of objects — NeoDB sends a single object for a
// bare mark and an array (Status + Comment, …) when the mark carries a comment.
function relatedWithEntries(obj: unknown): AnyObject[] {
  if (!obj || typeof obj !== 'object') return []
  const rw = (obj as AnyObject).relatedWith
  if (!rw) return []
  const arr = Array.isArray(rw) ? rw : [rw]
  return arr.filter((e): e is AnyObject => !!e && typeof e === 'object' && !Array.isArray(e))
}

// The `Status` entry — the shelf record that makes this object a mark.
function pickStatusEntry(entries: AnyObject[]): AnyObject | null {
  return entries.find(
    (e) => e.type === 'Status' && typeof e.withRegardTo === 'string' && e.withRegardTo.trim() !== '',
  ) ?? null
}

// The user's own comment on the mark, when NeoDB federated one alongside the Status.
// Scoped to the same catalogue item so a stray related record can't leak in.
function pickCommentEntry(entries: AnyObject[], itemUrl: string): AnyObject | null {
  return entries.find(
    (e) => e.type === 'Comment' && normalizeItemUrl(e.withRegardTo) === itemUrl,
  ) ?? null
}

// True when a `Note` (or any object) carries the NeoDB mark shape: a `relatedWith`
// Status pointing at a catalogue item. Ordinary Notes have no `relatedWith` and are
// left to normal post ingestion untouched (criterion 1).
export function isNeodbMark(obj: unknown): boolean {
  return pickStatusEntry(relatedWithEntries(obj)) != null
}

export interface ParsedNeodbMark {
  itemUrl: string
  actorApId: string
  itemType: string | null
  category: string | null
  status: string | null
  statusRaw: string | null
  statusKnown: boolean
  title: string | null
  coverUrl: string | null
  markApId: string | null
  markUrl: string | null
  postId: string | null
  publishedAt: Date | null
  updatedAtAp: Date | null
  // The shelf date: when the thing was actually watched / read / played / listened to,
  // read strictly off the `relatedWith` Status entry. Null when the mark carries none.
  watchedAt: Date | null
  // The user's comment on the mark, when NeoDB federated one (plain text, as NeoDB
  // sends it). Null for a bare mark.
  comment: string | null
  raw: { relatedWith: unknown; comment: unknown; tag: unknown }
}

// Parse a mark `Note` into the store-shaped record, or null when it isn't a mark.
// `actorApId` is the marking actor (the Note's attributedTo / delivering actor).
export function parseNeodbMark(obj: unknown, actorApId: string): ParsedNeodbMark | null {
  const entries = relatedWithEntries(obj)
  const rw = pickStatusEntry(entries)
  if (!rw) return null
  const o = obj as AnyObject

  // Canonical item id: withRegardTo is guaranteed present; the tag href is a fallback.
  const tag = pickNeodbTag(o.tag, normalizeItemUrl(rw.withRegardTo) ?? '')
  const itemUrl = normalizeItemUrl(rw.withRegardTo) ?? normalizeItemUrl(tag?.href)
  if (!itemUrl) return null

  const commentEntry = pickCommentEntry(entries, itemUrl)

  const itemType = strOrNull(tag?.type)
  const { status, raw: statusRaw, known: statusKnown } = mapMarkStatus(rw.status)
  const markApId = strOrNull(o.id) ?? strOrNull(rw.id)
  const markUrl = strOrNull(o.url) ?? markApId

  return {
    itemUrl,
    actorApId,
    itemType,
    category: mapItemTypeToCategory(itemType),
    status,
    statusRaw,
    statusKnown,
    title: strOrNull(tag?.name)?.trim() ?? null,
    coverUrl: strOrNull(tag?.image),
    markApId,
    markUrl,
    postId: extractPostId(markApId ?? markUrl),
    // The Note's own `published` — the post timestamp, i.e. when the mark was created.
    // For a mark federated at creation it happens to equal the shelf date, but for the
    // backfill pattern (mark now, correct the date in a follow-up `Update`) it does not,
    // so it is NOT the watch date. Read that off `watchedAt` below.
    publishedAt: parseDate(o.published) ?? parseDate(rw.published),
    // `relatedWith.updated` is the change-tracking stamp (bumped when the mark is re-saved,
    // e.g. a delete+recreate backfill); the Note's own `updated` is the fallback.
    updatedAtAp: parseDate(rw.updated) ?? parseDate(o.updated),
    // The shelf date, strictly `Status.published` — the day the film was seen, the book
    // finished, the album heard. Deliberately no fallback: the Note's `published` tracks
    // mark creation and the Comment entry's `published` tracks the comment, so falling
    // back to either would silently report "today" as the watch date for every backdated
    // mark. Unknown stays null.
    watchedAt: parseDate(rw.published),
    comment: strOrNull(commentEntry?.content),
    raw: { relatedWith: rw, comment: commentEntry ?? null, tag: tag ?? null },
  }
}
