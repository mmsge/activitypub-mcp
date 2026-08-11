// Parsing a Gigowl (samklang) gig attendance out of a federated ActivityPub `Note`.
//
// Gigowl — `samklang.msge.no`, software name "samklang" — publishes one `Note` per
// attendance at a concert. It is deliberately an ordinary Note, because a `Join` or a
// custom verb renders as nothing at all on Mastodon; the structure rides in tags that
// Mastodon drops harmlessly. The hooks we work off:
//
//   tag: { type:'Link', href:<concert url>, name:'Konsert', mediaType:'application/activity+json' }
//   tag: { type:'Link', href:'https://samklang.msge.no/ns#attended', name:'Oppmøte' }
//   tag: { type:'Hashtag', name:'#konsert' | '#<ArtistName>' }
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
// gig was attended, planned or merely wanted for every Note delivered before the
// `Oppmøte` tag existed (ADR 0026 over there).
//
// So the prose is read for exactly two things, both structural rather than semantic:
//
//   1. The RSVP status, and only as a last resort — an exact prefix match against the
//      three generated openings, yielding null rather than a guess for anything else.
//      The explicit tag and property both win over it when present.
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
 * Longest first: "Eg var på " and "Eg skal på " cannot collide, but ordering by length
 * makes the match independent of insertion order if a fourth state is ever added.
 */
const STATUS_PREFIXES: [string, string][] = [
  ['Eg har lyst til å sjå ', 'interested'],
  ['Eg skal på ', 'going'],
  ['Eg var på ', 'attended'],
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
 * gig_catalog rows are keyed on.
 */
export function normalizeSamklangUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
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
    if (concertUrl && normalizeSamklangUrl(block.text) === concertUrl) return false
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
    const url = strOrNull(a.url) ?? strOrNull((a.url as AnyObject | undefined)?.href)
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

  const noteApId = strOrNull(o.id)
  const noteUrl = strOrNull(o.url) ?? noteApId
  const { opening, review } = splitNoteBlocks(strOrNull(o.content), concertUrl)
  const { status, raw: statusRaw, known: statusKnown, source: statusSource } = resolveGigStatus(o, opening)

  return {
    concertUrl,
    actorApId,
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
