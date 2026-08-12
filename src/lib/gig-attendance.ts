// Parsing a Gigowl (samklang) gig attendance out of a federated ActivityPub `Note`.
//
// Gigowl — `gigowl.social`, software name "samklang" — publishes one `Note` per
// attendance at a concert. It is deliberately an ordinary Note, because a `Join` or a
// custom verb renders as nothing at all on Mastodon; the structure rides in tags that
// Mastodon drops harmlessly. The hooks we work off:
//
//   tag: { type:'Link', href:<concert url>, name:'Konsert', mediaType:'application/activity+json' }
//   tag: { type:'Link', href:'https://samklang.msge.no/ns#attended', name:'Attendance' }
//   tag: { type:'Hashtag', name:'#gig' | '#<ArtistName>' }
//   samklang:attendanceStatus: 'interested' | 'going' | 'attended'   (dereferenced Note only)
//
// The `Konsert` Link tag is the discriminator. Gigowl uses the same one on its own inbound
// path and also accepts `name: 'Concert'`, so both are recognised here.
//
// ── The one place this reads prose, and why that is not the usual mistake ──────────────
//
// `content` is not human copy. It is generated from a fixed template in Gigowl's
// `src/federation/note.ts`: four blocks — opening line, the write-up, the concert link, the
// hashtags — joined by a blank line and rendered one `<p>` each. That template is the
// sibling repo's, not a stranger's, and the opening line is the ONLY record of whether the
// gig was attended, planned or merely wanted for every Note delivered before the status
// tag existed (ADR 0026 over there). It was named `Oppmøte` then and `Attendance` now.
//
// So the prose is read for exactly two things, both structural rather than semantic:
//
//   1. The RSVP status, and only as a last resort — an exact prefix match against the
//      generated openings in both languages the origin has written them in, yielding null
//      rather than a guess for anything else. The tag and property both win over it.
//   2. Which blocks are NOT the write-up, so the write-up is what is left. Block 0 is the
//      opening; the link block is identified by equality with the concert URL; the hashtag
//      block by its `class="hashtag"` anchors. Nothing is matched on what it says.
//
// The title, the artists, the venue and the date are never taken from here. They come from
// enrichment, which dereferences the concert. That is the rule ADR 0008 records for NeoDB
// marks and it holds unchanged: prose is not a source of facts.
//
// Everything here is pure (no DB, no network) so it unit-tests on verified live payloads.
// The DB upsert and the tombstone live in jobs/sync-gig-attendances.ts.

type AnyObject = Record<string, unknown>

/** Gigowl's frozen JSON-LD namespace. A vocabulary id, not an address — never derived. */
export const SAMKLANG_NS = 'https://samklang.msge.no/ns#'

// ── The origin changed address, so every identifier here has two forms ─────────────────
//
// Gigowl moved from `samklang.msge.no` to `gigowl.social` and, in the same window, moved
// its whole URI space from Nynorsk to English (its ADR 0029 and 0030). Both halves show up
// in the identifiers this store is keyed on:
//
//   https://samklang.msge.no/konsert/<ULID>  →  https://gigowl.social/gig/<ULID>
//   https://samklang.msge.no/oppmote/<ULID>  →  https://gigowl.social/attendance/<ULID>
//   https://samklang.msge.no/brukar/markus   →  https://gigowl.social/user/markus
//
// The old domain 301s, so nothing is unreachable — but a redirect does not rescue an
// identifier. The two strings are one concert wearing two names, and a store keyed on the
// first files every re-delivered attendance as a second gig beside the first.
//
// So Gigowl URIs are canonicalised to the new space on the way in. The rows already stored
// were rewritten once by jobs/rebase-gig-origin.ts; this is what keeps a *replay* landing
// on the same row rather than beside it — `objects.raw` is kept verbatim as delivered, and
// the local-first backfill re-parses it.
export const LEGACY_GIG_ORIGIN = 'https://samklang.msge.no'
export const GIG_ORIGIN = 'https://gigowl.social'

/**
 * Nynorsk path segment → English, for the segments that can appear inside an identifier
 * we persist. A trimmed copy of `LEGACY_SEGMENTS` in the origin's `src/web/legacy-paths.ts`
 * — the ~50 interface routes there are paths nobody here ever stored.
 *
 * `artist` and `media` map to themselves: those names did not change, but a URL under them
 * still has to change host, and listing them is what lets one table decide both halves.
 *
 * `ns` is deliberately ABSENT, and that absence is the safety property. A URL whose first
 * segment is not in this table is returned untouched, so `SAMKLANG_NS` above — a vocabulary
 * identifier shared by every instance of the software rather than an address on one of them
 * — never moves, no matter how many times this runs.
 */
const LEGACY_PATH_SEGMENTS: Record<string, string> = {
  konsert: 'gig',
  stad: 'venue',
  setliste: 'setlist',
  oppmote: 'attendance',
  brukar: 'user',
  innboks: 'inbox',
  utboks: 'outbox',
  fylgjarar: 'followers',
  fylgjer: 'following',
  artist: 'artist',
  media: 'media',
}

/**
 * The URI prefixes `canonicalGigUri` will actually move, as `<old>` → `<new>` pairs.
 *
 * For SQL, which cannot call the function: it is how the rebase job tells "still at the old
 * address because we missed it" from "still at the old address because it does not belong to
 * the new one". Not everything under the old origin has a successor —
 * `https://samklang.msge.no/aktivitet/<ULID>` is a transient Follow/Accept id the origin
 * mints per delivery, absent from both its entity paths and its redirect map, so it names an
 * activity that really was issued at that address and nothing else, forever.
 */
export const MOVABLE_GIG_URI_PREFIXES: [string, string][] = Object.entries(LEGACY_PATH_SEGMENTS)
  .map(([was, now]) => [`${LEGACY_GIG_ORIGIN}/${was}/`, `${GIG_ORIGIN}/${now}/`])

function segmentKey(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is not ours to fix; look the segment up as it arrived.
    return segment
  }
}

function mapSegment(segment: string): string {
  const key = segmentKey(segment)
  return Object.hasOwn(LEGACY_PATH_SEGMENTS, key) ? LEGACY_PATH_SEGMENTS[key]! : segment
}

/**
 * A Gigowl URI in its current form. Anything else — a URL on another host, a URL already
 * in the new space, the `/ns#` vocabulary — is returned exactly as given.
 *
 * Idempotent, because no English target is also a Nynorsk source (the origin asserts that
 * in its own test suite): a rewritten URI has no legacy segments left to rewrite.
 */
export function canonicalGigUri(raw: string): string {
  if (!raw.startsWith(`${LEGACY_GIG_ORIGIN}/`)) return raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const segments = url.pathname.split('/')
  // segments[0] is the empty string before the leading slash; [1] is what decides whether
  // this is an identifier at all. An unknown first segment moves nothing.
  if (!Object.hasOwn(LEGACY_PATH_SEGMENTS, segmentKey(segments[1] ?? ''))) return raw
  url.host = new URL(GIG_ORIGIN).host
  url.pathname = segments.map(mapSegment).join('/')
  return url.toString()
}

/** `canonicalGigUri` for a value that may not be a string. Null passes through. */
function canonicalOrNull(raw: string | null): string | null {
  return raw == null ? null : canonicalGigUri(raw)
}

/** The `name` on the Link tag that points at the concert. Gigowl emits the Nynorsk one. */
const CONCERT_TAG_NAMES = new Set(['konsert', 'concert'])

/** The `name` on the Link tag carrying the RSVP state. */
const STATUS_TAG_NAMES = new Set(['oppmøte', 'oppmote', 'attendance'])

/**
 * The RSVP vocabulary. Gigowl's own three states; anything else is kept verbatim and
 * flagged rather than dropped, so a state added later never crashes the store.
 */
export const GIG_STATUS_MAP: Record<string, string> = {
  interested: 'interested',
  going: 'going',
  attended: 'attended',
}

/**
 * The generated opening line of each state, as an exact prefix.
 *
 * Six entries for three states because the origin's copy moved from Nynorsk to UK English
 * (Gigowl's ADR 0032) at the same time as the domain. Already-delivered posts are immutable
 * copies and stay Nynorsk, so both templates are live in the archive at once and neither
 * set can be dropped.
 *
 * Longest first: none of these can collide, but ordering by length makes the match
 * independent of insertion order if a fourth state is ever added.
 */
const STATUS_PREFIXES: [string, string][] = [
  ['Eg har lyst til å sjå ', 'interested'],
  ['I would like to see ', 'interested'],
  ['I am going to ', 'going'],
  ['Eg skal på ', 'going'],
  ['Eg var på ', 'attended'],
  ['I was at ', 'attended'],
]

export function mapGigStatus(verb: unknown): { status: string | null; raw: string | null; known: boolean } {
  const raw = typeof verb === 'string' && verb.trim() ? verb.trim() : null
  if (!raw) return { status: null, raw: null, known: false }
  const key = raw.toLowerCase()
  const mapped = GIG_STATUS_MAP[key]
  return { status: mapped ?? key, raw, known: mapped != null }
}

/**
 * Canonicalise a Gigowl catalogue URL so the Link tag href, the `samklang:concert`
 * property and the link in the generated prose all collapse to one key — the value
 * gig_catalog rows are keyed on. A URI still on the origin's old address is moved to its
 * current one first, so an old payload and a new delivery key the same.
 */
export function normalizeSamklangUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = canonicalGigUri(raw.trim())
  try {
    const u = new URL(s)
    u.hash = ''
    u.search = ''
    u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString()
  } catch {
    return s.replace(/\/+$/, '')
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

function toTagArray(v: unknown): AnyObject[] {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.filter((t): t is AnyObject => !!t && typeof t === 'object')
}

function tagName(tag: AnyObject): string {
  return typeof tag.name === 'string' ? tag.name.trim().toLowerCase() : ''
}

/** The Link tag pointing at the concert, whichever of the two names it carries. */
function pickConcertTag(obj: unknown): AnyObject | null {
  if (!obj || typeof obj !== 'object') return null
  return (
    toTagArray((obj as AnyObject).tag).find(
      (tag) => tag.type === 'Link' && CONCERT_TAG_NAMES.has(tagName(tag)) && strOrNull(tag.href) != null,
    ) ?? null
  )
}

/**
 * True when an object is a Gigowl attendance. An ordinary Note has no such tag and falls
 * straight through to normal post ingestion, exactly as a non-mark Note does.
 */
export function isGigAttendance(obj: unknown): boolean {
  return pickConcertTag(obj) != null
}

/** Where a parsed status came from, so a caller can tell a stated fact from a derived one. */
export type GigStatusSource = 'tag' | 'property' | 'template' | null

/**
 * The RSVP state, in strict precedence: the explicit Link tag, then the explicit property
 * (present only on a Note fetched from its own URI), then the generated opening line.
 *
 * The first two did not exist before Gigowl's ADR 0026, which is the entire reason the
 * third does. Unrecognised prose yields null — never a guess, because "wanted to go" being
 * silently recorded as "went" is worse than not knowing.
 */
export function resolveGigStatus(
  obj: unknown,
  openingLine: string | null,
): { status: string | null; raw: string | null; known: boolean; source: GigStatusSource } {
  const o = (obj ?? {}) as AnyObject

  const statusTag = toTagArray(o.tag).find(
    (tag) => tag.type === 'Link' && STATUS_TAG_NAMES.has(tagName(tag)) && strOrNull(tag.href) != null,
  )
  if (statusTag) {
    const href = strOrNull(statusTag.href)!
    const verb = href.startsWith(SAMKLANG_NS) ? href.slice(SAMKLANG_NS.length) : href.split('#').pop() ?? null
    const mapped = mapGigStatus(verb)
    if (mapped.status) return { ...mapped, source: 'tag' }
  }

  const property = strOrNull(o['samklang:attendanceStatus']) ?? strOrNull(o.attendanceStatus)
  if (property) {
    const mapped = mapGigStatus(property)
    if (mapped.status) return { ...mapped, source: 'property' }
  }

  if (openingLine) {
    for (const [prefix, status] of STATUS_PREFIXES) {
      if (openingLine.startsWith(prefix)) return { status, raw: status, known: true, source: 'template' }
    }
  }

  return { status: null, raw: null, known: false, source: null }
}

/**
 * Split the generated `content` into its blocks and label the three we can identify
 * structurally, leaving everything else as the write-up.
 *
 * Works off the HTML, not the plain text: the paragraphs are what carry the block
 * boundaries, and `stripHtml` collapses them to single newlines — after which an opening
 * line and a one-line write-up are indistinguishable from a two-line write-up.
 */
export function splitNoteBlocks(
  content: string | null | undefined,
  concertUrl: string | null,
): { opening: string | null; review: string | null } {
  if (!content || !content.trim()) return { opening: null, review: null }

  // Both sides of the link-block comparison below go through the same normaliser, so it
  // holds whichever address the caller's concert URL and the prose happen to be on — a Note
  // written before the origin moved links to the old one in prose we did not write.
  const concert = normalizeSamklangUrl(concertUrl)

  const paragraphs = content.includes('</p>')
    ? content.split(/<\/p\s*>/i).filter((block) => block.trim() !== '')
    : [content]

  const blocks = paragraphs.map((block) => ({ html: block, text: plainText(block) }))
  const opening = blocks.length > 0 ? blocks[0]!.text || null : null

  const rest = blocks.slice(1).filter((block) => {
    if (!block.text) return false
    // The hashtag block: Gigowl marks every tag anchor with class="hashtag".
    if (/class\s*=\s*["']?hashtag/i.test(block.html)) return false
    // The link block: the concert URL on its own line.
    if (concert && normalizeSamklangUrl(block.text) === concert) return false
    return true
  })

  const review = rest.map((block) => block.text).join('\n\n').trim()
  return { opening, review: review || null }
}

// Tags out, entities decoded, `<br>` to newline. Deliberately local and minimal rather
// than reusing stripHtml: this runs per block, and must not collapse the blank lines that
// separate a multi-paragraph write-up.
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** A photo attached to the attendance. Gigowl serves WebP only, with alt text in `name`. */
export interface GigPhoto {
  url: string
  mediaType: string | null
  altText: string | null
  width: number | null
  height: number | null
}

function extractPhotos(obj: AnyObject): GigPhoto[] {
  const raw = obj.attachment
  const list = !raw ? [] : Array.isArray(raw) ? raw : [raw]
  const out: GigPhoto[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const a = item as AnyObject
    const url = canonicalOrNull(strOrNull(a.url) ?? strOrNull((a.url as AnyObject | undefined)?.href))
    if (!url) continue
    out.push({
      url,
      mediaType: strOrNull(a.mediaType),
      altText: strOrNull(a.name),
      width: typeof a.width === 'number' ? a.width : null,
      height: typeof a.height === 'number' ? a.height : null,
    })
  }
  return out
}

function extractHashtags(obj: AnyObject): string[] {
  return toTagArray(obj.tag)
    .filter((tag) => tag.type === 'Hashtag')
    .map((tag) => strOrNull(tag.name))
    .filter((name): name is string => name != null)
}

/** The origin-local id from an attendance URL: `…/oppmote/01KZ…` → "01KZ…". */
function extractPostId(url: string | null): string | null {
  if (!url) return null
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    return segs.length ? segs[segs.length - 1]! : null
  } catch {
    return null
  }
}

export interface ParsedGigAttendance {
  concertUrl: string
  actorApId: string
  status: string | null
  statusRaw: string | null
  statusKnown: boolean
  statusSource: GigStatusSource
  /** The write-up, verbatim. Free text, never parsed or normalised. */
  review: string | null
  /** The Note's `summary` — Gigowl puts the content warning there, as Mastodon renders it. */
  contentWarning: string | null
  hashtags: string[]
  photos: GigPhoto[]
  noteApId: string | null
  noteUrl: string | null
  postId: string | null
  /**
   * The Note's own `published`. Gigowl sets it to the attendance's `updatedAt`, so this is
   * when the gig was LOGGED or last edited, never when it happened — a 2022 gig entered in
   * 2026 publishes in 2026. The night itself comes from the concert record.
   */
  publishedAt: Date | null
  updatedAtAp: Date | null
  raw: { concertTag: unknown; tags: unknown; attachment: unknown }
}

/**
 * Parse an attendance `Note` into the store-shaped record, or null when it isn't one.
 * `actorApId` is the attending actor (the Note's attributedTo / the delivering actor).
 */
export function parseGigAttendance(obj: unknown, actorApId: string): ParsedGigAttendance | null {
  const concertTag = pickConcertTag(obj)
  if (!concertTag) return null
  const o = obj as AnyObject

  // The property is the more authoritative of the two when both are present; they only
  // ever disagree if a concert has been merged, in which case the property is the newer.
  const concertUrl =
    normalizeSamklangUrl(o['samklang:concert']) ?? normalizeSamklangUrl(concertTag.href)
  if (!concertUrl) return null

  // The Note's own id, its permalink and the attending actor all live in the origin's URI
  // space too, so they move with it — otherwise a replayed old payload would file a second
  // row under the old actor, and a Delete naming the new Note id would tombstone nothing.
  const noteApId = canonicalOrNull(strOrNull(o.id))
  const noteUrl = canonicalOrNull(strOrNull(o.url)) ?? noteApId
  const { opening, review } = splitNoteBlocks(strOrNull(o.content), concertUrl)
  const { status, raw: statusRaw, known: statusKnown, source: statusSource } = resolveGigStatus(o, opening)

  return {
    concertUrl,
    actorApId: canonicalGigUri(actorApId),
    status,
    statusRaw,
    statusKnown,
    statusSource,
    review,
    contentWarning: strOrNull(o.summary),
    hashtags: extractHashtags(o),
    photos: extractPhotos(o),
    noteApId,
    noteUrl,
    postId: extractPostId(noteApId ?? noteUrl),
    publishedAt: parseDate(o.published),
    updatedAtAp: parseDate(o.updated),
    raw: { concertTag, tags: o.tag ?? null, attachment: o.attachment ?? null },
  }
}

/** Every Gigowl concert URL an object references, for the enrichment queue. */
export function collectConcertUrls(obj: unknown): string[] {
  const tag = pickConcertTag(obj)
  const urls = new Set<string>()
  const fromProperty = normalizeSamklangUrl((obj as AnyObject)?.['samklang:concert'])
  if (fromProperty) urls.add(fromProperty)
  const fromTag = normalizeSamklangUrl(tag?.href)
  if (fromTag) urls.add(fromTag)
  return [...urls]
}
