import { escapeHtml } from './html.js'

/**
 * Turn a `tiktok-archive/1` file into the shapes the ActivityPub ingest stores: one Person
 * for the account, one Video (or Image, for a photo post) per post.
 *
 * The file is not TikTok's own export. `scripts/build-tiktok-archive.ts` builds it on the
 * Mac where the archive lives, from the data export and yt-dlp's metadata, and only this
 * file reaches the server. Pure — no filesystem, no database — so every mapping is
 * unit-testable. The job that writes the rows is src/jobs/import-tiktok-archive.ts. See
 * ADR 0078, which follows ADR 0067 (the Twitter archives) almost line for line.
 *
 * The rule that shapes everything below: **the post is kept whole, the ActivityPub object
 * is a view of it.** The post exactly as the file gave it rides along in
 * `raw.tiktokArchive.post`, so a field nobody thought to map is a re-run and never a
 * re-export. Views and the sound have no ActivityStreams property; they are read from there.
 */

type AnyObject = Record<string, unknown>

export const TIKTOK_ARCHIVE_FORMAT = 'tiktok-archive/1'
/** The handle's domain: `@markusrote@tiktok.com`. */
export const TIKTOK_DOMAIN = 'tiktok.com'
/** The host every TikTok page lives on, and so every `ap_id` and `url` here. */
export const TIKTOK_WEB_HOST = 'www.tiktok.com'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

/** A file that is not a `tiktok-archive/1` at all. A bad post is a problem, not this. */
export class TiktokArchiveError extends Error {}

export interface TiktokAccount {
  username: string
  displayName: string
}

/** One post, exactly the fields the build script writes. */
export interface TiktokArchivePost {
  /** ISO 8601, UTC. The export's `Date`, which is also yt-dlp's `timestamp` to the second. */
  postedAt: string
  kind: 'video' | 'photo'
  /** TikTok's id. Null for a post yt-dlp did not find: the export carries no id. */
  id: string | null
  url: string | null
  description: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  durationSeconds: number | null
  sound: string | null
  location: string | null
  whoCanView: string | null
  /** Whether the post was found on the public profile when the file was built. */
  onProfile: boolean
}

export interface TiktokArchive {
  format: typeof TIKTOK_ARCHIVE_FORMAT
  account: TiktokAccount
  generatedAt: string | null
  posts: TiktokArchivePost[]
}

export interface PostProblem {
  /** Position in the file's `posts`, from 0. */
  index: number
  postedAt: string | null
  reason: string
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** `https://www.tiktok.com/@markusrote`: the account's `ap_id`, and its profile page. */
export function actorApId(username: string): string {
  return `https://${TIKTOK_WEB_HOST}/@${username}`
}

/** `@markusrote@tiktok.com`: the form every `actor_handle` parameter takes. */
export function actorHandle(username: string): string {
  return `@${username}@${TIKTOK_DOMAIN}`
}

/** The canonical page of a post with an id, which doubles as its `ap_id`. */
export function postUrl(username: string, kind: TiktokArchivePost['kind'], id: string): string {
  return `https://${TIKTOK_WEB_HOST}/@${username}/${kind === 'photo' ? 'photo' : 'video'}/${id}`
}

/**
 * The `ap_id` of a post the export knows and TikTok no longer shows: no id, so no page.
 *
 * Built from the second it was posted, on the archive domain, so it is stable across
 * re-imports, unique per account (the export cannot hold two posts in one second without
 * the build script reporting it), and never mistaken for a real address. It is never
 * served as a `url`: a link that does not open is worse than none.
 * `2022-05-05T12:00:00.000Z` → `https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z`.
 */
export function archivedPostApId(username: string, postedAt: string): string {
  const stamp = new Date(postedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  return `${actorApId(username)}#arkiv-${stamp}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const USERNAME = /^[A-Za-z0-9_.]{1,64}$/
const ID = /^\d{1,30}$/

const isObj = (v: unknown): v is AnyObject => !!v && typeof v === 'object' && !Array.isArray(v)

function optString(v: unknown, field: string): string | null {
  if (v == null) return null
  if (typeof v !== 'string') throw new Error(`${field} is not a string`)
  return v.trim() === '' ? null : v
}

function optCount(v: unknown, field: string): number | null {
  if (v == null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${field} is not a whole number ≥ 0`)
  return v
}

/**
 * Read and check a `tiktok-archive/1` document.
 *
 * Throws TiktokArchiveError when the file is not one at all (wrong format, no account, no
 * posts array); that is a wrong upload and nothing should be written. A single post that
 * does not check out is a problem, listed and left out, and the rest are kept.
 */
export function parseTiktokArchive(input: unknown): { archive: TiktokArchive; problems: PostProblem[] } {
  if (!isObj(input)) throw new TiktokArchiveError('Not a TikTok archive: expected a JSON object')
  if (input.format !== TIKTOK_ARCHIVE_FORMAT) {
    throw new TiktokArchiveError(
      `Not a TikTok archive: format is ${JSON.stringify(input.format ?? null)}, expected "${TIKTOK_ARCHIVE_FORMAT}". Build it with npm run build-tiktok-archive.`,
    )
  }
  const acct = input.account
  if (!isObj(acct) || typeof acct.username !== 'string' || !USERNAME.test(acct.username)) {
    throw new TiktokArchiveError('Not a TikTok archive: account.username is missing or not a TikTok username')
  }
  const username = acct.username.toLowerCase()
  const displayName = typeof acct.displayName === 'string' && acct.displayName.trim() ? acct.displayName.trim() : username
  if (!Array.isArray(input.posts)) throw new TiktokArchiveError('Not a TikTok archive: posts is not a list')

  const generatedAt = typeof input.generatedAt === 'string' && !Number.isNaN(Date.parse(input.generatedAt))
    ? new Date(input.generatedAt).toISOString()
    : null

  const posts: TiktokArchivePost[] = []
  const problems: PostProblem[] = []
  input.posts.forEach((raw, index) => {
    const postedAtRaw = isObj(raw) && typeof raw.postedAt === 'string' ? raw.postedAt : null
    try {
      posts.push(checkPost(raw, username))
    } catch (e) {
      problems.push({ index, postedAt: postedAtRaw, reason: e instanceof Error ? e.message : String(e) })
    }
  })

  return { archive: { format: TIKTOK_ARCHIVE_FORMAT, account: { username, displayName }, generatedAt, posts }, problems }
}

function checkPost(raw: unknown, username: string): TiktokArchivePost {
  if (!isObj(raw)) throw new Error('post is not an object')

  if (typeof raw.postedAt !== 'string' || Number.isNaN(Date.parse(raw.postedAt))) {
    throw new Error('postedAt is missing or not a date')
  }
  const postedAt = new Date(raw.postedAt).toISOString()

  if (raw.kind !== 'video' && raw.kind !== 'photo') throw new Error(`kind is ${JSON.stringify(raw.kind ?? null)}, expected "video" or "photo"`)
  const kind = raw.kind

  // A number would already have lost digits in JSON.parse: TikTok ids are past 2^53.
  if (raw.id != null && (typeof raw.id !== 'string' || !ID.test(raw.id))) throw new Error('id is not a string of digits')
  const id = raw.id ?? null

  let url = optString(raw.url, 'url')
  if (url && !id) throw new Error('url without an id: nothing to check it against')
  if (id) {
    // The file's url is only trusted when it is the page of this very post on TikTok.
    // Anything else would be an ap_id or a link pointing somewhere the archive cannot vouch for.
    const canonical = postUrl(username, kind, id)
    if (url) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('url is not a URL')
      }
      if (parsed.protocol !== 'https:' || parsed.hostname !== TIKTOK_WEB_HOST || !parsed.pathname.endsWith(`/${id}`)) {
        throw new Error(`url is not the TikTok page of post ${id}`)
      }
    }
    url = canonical
  }

  const durationSeconds = raw.durationSeconds == null ? null : raw.durationSeconds
  if (durationSeconds != null && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error('durationSeconds is not a number ≥ 0')
  }

  if (typeof raw.onProfile !== 'boolean') throw new Error('onProfile is not true or false')

  return {
    postedAt,
    kind,
    id,
    url,
    description: optString(raw.description, 'description'),
    views: optCount(raw.views, 'views'),
    likes: optCount(raw.likes, 'likes'),
    comments: optCount(raw.comments, 'comments'),
    shares: optCount(raw.shares, 'shares'),
    durationSeconds,
    sound: optString(raw.sound, 'sound'),
    location: optString(raw.location, 'location'),
    whoCanView: optString(raw.whoCanView, 'whoCanView'),
    onProfile: raw.onProfile,
  }
}

// ---------------------------------------------------------------------------
// Description → HTML and tags
// ---------------------------------------------------------------------------

type Part =
  | { kind: 'text'; value: string }
  | { kind: 'hashtag'; tag: string }
  | { kind: 'mention'; username: string }

/**
 * A hashtag or a mention, as TikTok links them in a caption. Not inside a word, a path or
 * an e-mail address: the character before must not be a letter, digit, `_`, `/`, `@` or `#`.
 */
const TOKEN = /(?<![\p{L}\p{M}\p{N}_/@#])(?:#([\p{L}\p{M}\p{N}_]+)|@([A-Za-z0-9_.]+))/gu
/** TikTok usernames: 2–24 letters, digits, `_` and `.`, never ending in `.`. */
const MENTIONABLE = /^[A-Za-z0-9_.]{2,24}$/

function partsOf(text: string): Part[] {
  const parts: Part[] = []
  let cursor = 0
  const pushText = (value: string) => {
    if (!value) return
    const last = parts[parts.length - 1]
    if (last?.kind === 'text') last.value += value
    else parts.push({ kind: 'text', value })
  }
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    pushText(text.slice(cursor, at))
    cursor = at + m[0].length
    if (m[1] != null) {
      parts.push({ kind: 'hashtag', tag: m[1] })
      continue
    }
    // A sentence ending in a mention ("takk til @x.") keeps its full stop as text.
    const name = m[2]!.replace(/\.+$/, '')
    const trailing = m[2]!.slice(name.length)
    if (MENTIONABLE.test(name)) {
      parts.push({ kind: 'mention', username: name.toLowerCase() })
      pushText(trailing)
    } else {
      pushText(m[0])
    }
  }
  pushText(text.slice(cursor))
  return parts
}

function hashtagHref(tag: string): string {
  return `https://${TIKTOK_WEB_HOST}/tag/${encodeURIComponent(tag)}`
}

/**
 * The caption as the Mastodon-flavoured HTML every other post in `objects.content` is:
 * hashtags and mentions linked the way Mastodon links them, so `stripHtml` gives back the
 * caption's own words and search reads them. Paragraphs on blank lines, `<br>` on single
 * newlines.
 */
export function renderDescriptionHtml(description: string | null): string {
  if (!description) return ''
  const inline = partsOf(description.replace(/\r\n?/g, '\n'))
    .map((p) => {
      switch (p.kind) {
        case 'text':
          return escapeHtml(p.value)
        case 'hashtag':
          return `<a href="${escapeHtml(hashtagHref(p.tag))}" class="mention hashtag" rel="tag">#<span>${escapeHtml(p.tag)}</span></a>`
        case 'mention':
          return (
            `<span class="h-card"><a href="${escapeHtml(actorApId(p.username))}" class="u-url mention" ` +
            `rel="nofollow noopener noreferrer" target="_blank">@<span>${escapeHtml(p.username)}</span></a></span>`
          )
      }
    })
    .join('')
    .trim()
  if (!inline) return ''
  return inline
    .split(/\n{2,}/)
    .map((para) => `<p>${para.trim().replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** The caption's hashtags and mentions as AS2 tags, each once (hashtags case-insensitively). */
export function descriptionTags(description: string | null): AnyObject[] {
  if (!description) return []
  const tags: AnyObject[] = []
  const seen = new Set<string>()
  for (const p of partsOf(description)) {
    if (p.kind === 'hashtag') {
      const key = `#${p.tag.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      tags.push({ type: 'Hashtag', href: hashtagHref(p.tag), name: `#${p.tag}` })
    } else if (p.kind === 'mention') {
      const key = `@${p.username}`
      if (seen.has(key)) continue
      seen.add(key)
      tags.push({ type: 'Mention', href: actorApId(p.username), name: actorHandle(p.username) })
    }
  }
  return tags
}

// ---------------------------------------------------------------------------
// Post → ActivityPub object
// ---------------------------------------------------------------------------

export interface BuiltPost {
  /** The `objects.type`: `Video`, or `Image` for a photo post. */
  type: 'Video' | 'Image'
  apId: string
  object: AnyObject
}

/**
 * Who a post was addressed to, in the shape the `visibility` column reads (ADR 0017).
 *
 * "Everyone" is public. Any other setting (friends, followers, only me) is private, with
 * nobody named: the audience was a TikTok list this archive does not hold. No setting at
 * all is left unaddressed, which reads as `unknown` and fails closed, like any other post
 * whose addressing cannot be read.
 */
function audience(whoCanView: string | null, mentioned: string[]): AnyObject {
  if (whoCanView == null) return {}
  if (whoCanView.trim().toLowerCase() === 'everyone') return { to: [PUBLIC], cc: mentioned }
  return { to: [], cc: [] }
}

const collection = (totalItems: number) => ({ type: 'Collection', totalItems })

export function postToObject(post: TiktokArchivePost, account: TiktokAccount): BuiltPost {
  const actor = actorApId(account.username)
  const apId = post.id && post.url ? post.url : archivedPostApId(account.username, post.postedAt)
  const type: BuiltPost['type'] = post.kind === 'photo' ? 'Image' : 'Video'

  const tag = descriptionTags(post.description)
  const mentioned = tag
    .filter((t) => t.type === 'Mention' && t.href !== actor)
    .map((t) => t.href as string)

  const object: AnyObject = {
    '@context': AS_CONTEXT,
    id: apId,
    type,
    attributedTo: actor,
    published: post.postedAt,
    ...audience(post.whoCanView, mentioned),
    // Only a page that opens. A post TikTok no longer shows has an ap_id and no url.
    ...(post.id && post.url ? { url: post.url } : {}),
    content: renderDescriptionHtml(post.description),
    sensitive: false,
    ...(post.durationSeconds != null ? { duration: `PT${post.durationSeconds}S` } : {}),
    ...(tag.length ? { tag } : {}),
    ...(post.location ? { location: { type: 'Place', name: post.location } } : {}),
    ...(post.likes != null ? { likes: collection(post.likes) } : {}),
    ...(post.shares != null ? { shares: collection(post.shares) } : {}),
    ...(post.comments != null ? { replies: collection(post.comments) } : {}),
    // The post exactly as the file gave it. Nothing above is allowed to be the only copy.
    tiktokArchive: { username: account.username, post },
  }

  return { type, apId, object }
}

// ---------------------------------------------------------------------------
// Account → ActivityPub Person
// ---------------------------------------------------------------------------

export interface BuiltTiktokActor {
  apId: string
  handle: string
  username: string
  domain: string
  displayName: string
  raw: AnyObject
}

/**
 * The account. No avatar, banner or bio: the archive is posts, and the file carries none
 * of them. `generatedAt` says when the file was built, which is the "as of" of every count.
 */
export function buildTiktokActor(account: TiktokAccount, generatedAt: string | null = null): BuiltTiktokActor {
  const apId = actorApId(account.username)
  return {
    apId,
    handle: actorHandle(account.username),
    username: account.username,
    domain: TIKTOK_DOMAIN,
    displayName: account.displayName,
    raw: {
      '@context': AS_CONTEXT,
      id: apId,
      type: 'Person',
      preferredUsername: account.username,
      name: account.displayName,
      url: apId,
      tiktokArchive: { generatedAt },
    },
  }
}
