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

// True when a `Note` (or any object) carries the NeoDB mark shape: a `relatedWith`
// Status pointing at a catalogue item. Ordinary Notes have no `relatedWith` and are
// left to normal post ingestion untouched (criterion 1).
export function isNeodbMark(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false
  const rw = (obj as AnyObject).relatedWith as AnyObject | undefined
  if (!rw || typeof rw !== 'object' || Array.isArray(rw)) return false
  return rw.type === 'Status' && typeof rw.withRegardTo === 'string' && rw.withRegardTo.trim() !== ''
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
  raw: { relatedWith: unknown; tag: unknown }
}

// Parse a mark `Note` into the store-shaped record, or null when it isn't a mark.
// `actorApId` is the marking actor (the Note's attributedTo / delivering actor).
export function parseNeodbMark(obj: unknown, actorApId: string): ParsedNeodbMark | null {
  if (!isNeodbMark(obj)) return null
  const o = obj as AnyObject
  const rw = o.relatedWith as AnyObject

  // Canonical item id: withRegardTo is guaranteed present; the tag href is a fallback.
  const tag = pickNeodbTag(o.tag, normalizeItemUrl(rw.withRegardTo) ?? '')
  const itemUrl = normalizeItemUrl(rw.withRegardTo) ?? normalizeItemUrl(tag?.href)
  if (!itemUrl) return null

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
    // The mark's own `published` is the watched/read date; `relatedWith.published` is the
    // same instant and serves as a fallback.
    publishedAt: parseDate(o.published) ?? parseDate(rw.published),
    // `relatedWith.updated` is the change-tracking stamp (bumped when the mark is re-saved,
    // e.g. a delete+recreate backfill); the Note's own `updated` is the fallback.
    updatedAtAp: parseDate(rw.updated) ?? parseDate(o.updated),
    raw: { relatedWith: rw, tag: tag ?? null },
  }
}
