import { basename, extname } from 'node:path'
import { escapeHtml } from './html.js'

/**
 * Turn a Twitter "Download an archive of your data" export into the same shapes the
 * ActivityPub ingest stores: one Person per archive, one Note per tweet.
 *
 * Pure — no filesystem, no database — so the whole mapping is unit-testable. The job
 * that reads the files and writes the rows is src/jobs/import-twitter-archive.ts.
 * See ADR 0067.
 *
 * The rule that shapes everything below: **the archive is kept whole, the ActivityPub
 * object is a view of it.** The tweet exactly as Twitter exported it rides along in
 * `raw.twitterArchive.tweet`, so a field nobody thought to map (source client, counts,
 * display_text_range, an entity kind added next year) is a re-derivation and never a
 * re-export — the archive cannot be regenerated, Twitter no longer serves these accounts
 * the way it did in 2020. What is mapped is mapped to the vocabulary every other tool in
 * this repo already reads (`content`, `inReplyTo`, `tag`, `attachment`, `to`/`cc`).
 */

type AnyObject = Record<string, unknown>

export const TWITTER_DOMAIN = 'twitter.com'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

/** One account's identity, as far as the archive knows it. */
export interface TwitterAccount {
  accountId: string
  /** The CURRENT screen name — the one the account ended on, which is what the handle is. */
  username: string
  displayName: string
  createdAt: string | null
  createdVia: string | null
  bio: string
  website: string
  location: string
  avatarUrl: string | null
  headerUrl: string | null
  /** Every rename, oldest first. The archive's own tweets carry the name of their day. */
  screenNameChanges: Array<{ changedAt: string; changedFrom: string; changedTo: string }>
  timeZone: string | null
  verified: boolean | null
}

/**
 * The array inside a `window.YTD.<name>.partN = [ … ]` file.
 *
 * The export is JavaScript, not JSON: a one-line assignment in front of a JSON array. The
 * array is found by its first bracket rather than by matching the assignment, because the
 * name changes between archive generations (`tweet`, `tweets`) and every one of them is
 * followed by exactly one array.
 */
export function parseYtd(text: string): unknown[] {
  const start = text.indexOf('[')
  if (start < 0) throw new Error('not a Twitter archive data file: no array found')
  const parsed: unknown = JSON.parse(text.slice(start))
  if (!Array.isArray(parsed)) throw new Error('not a Twitter archive data file: top level is not an array')
  return parsed
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Twitter writes every number as a string ("3", "832000"). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * `Wed Sep 18 11:29:17 +0000 2013` (Twitter's v1 format) or ISO, as an ISO string — or
 * null when it is neither. V8 parses the Twitter form natively; the null is for the day an
 * export spells it some third way, so the caller can report the tweet instead of storing
 * an Invalid Date.
 */
export function parseTwitterDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * The account, from `account.js`, `profile.js` and the optional small files beside them.
 *
 * Deliberately NOT read: `email` and `phoneNumber` from account.js, and the IP audit. They
 * are in the export because it is a data-protection export; none of them is part of a
 * public profile, and a database row nobody asked for is a liability nobody needs.
 */
export function parseAccount(files: {
  account: unknown[]
  profile?: unknown[]
  screenNameChange?: unknown[]
  accountTimezone?: unknown[]
  verified?: unknown[]
}): TwitterAccount {
  const acct = (files.account[0] as AnyObject | undefined)?.account as AnyObject | undefined
  const accountId = str(acct?.accountId)
  const username = str(acct?.username)
  if (!acct || !accountId || !username) throw new Error('account.js carries no accountId/username')

  const profile = (files.profile?.[0] as AnyObject | undefined)?.profile as AnyObject | undefined
  const description = (profile?.description ?? {}) as AnyObject

  const changes = (files.screenNameChange ?? [])
    .map((e) => ((e as AnyObject).screenNameChange as AnyObject | undefined)?.screenNameChange as AnyObject | undefined)
    .filter((c): c is AnyObject => !!c)
    .map((c) => ({
      changedAt: parseTwitterDate(c.changedAt) ?? str(c.changedAt),
      changedFrom: str(c.changedFrom),
      changedTo: str(c.changedTo),
    }))
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt))

  const tz = (files.accountTimezone?.[0] as AnyObject | undefined)?.accountTimezone as AnyObject | undefined
  const ver = (files.verified?.[0] as AnyObject | undefined)?.verified as AnyObject | undefined

  return {
    accountId,
    username,
    displayName: str(acct.accountDisplayName) || username,
    createdAt: parseTwitterDate(acct.createdAt),
    createdVia: strOrNull(acct.createdVia),
    bio: str(description.bio),
    website: str(description.website),
    location: str(description.location),
    avatarUrl: strOrNull(profile?.avatarMediaUrl),
    headerUrl: strOrNull(profile?.headerMediaUrl),
    screenNameChanges: changes,
    timeZone: strOrNull(tz?.timeZone),
    verified: typeof ver?.verified === 'boolean' ? ver.verified : null,
  }
}

// ---------------------------------------------------------------------------
// Identity: how this account and its tweets are addressed
// ---------------------------------------------------------------------------

/** `https://twitter.com/MThorr` — the account's `ap_id`, and where its profile lives. */
export function actorApId(username: string): string {
  return `https://${TWITTER_DOMAIN}/${username}`
}

/** `@MThorr@twitter.com` — the form every `actor_handle` parameter takes. */
export function actorHandle(username: string): string {
  return `@${username}@${TWITTER_DOMAIN}`
}

/** A tweet's permalink, which doubles as its `ap_id`: stable, unique, and the real address. */
export function tweetUrl(username: string, id: string): string {
  return `https://${TWITTER_DOMAIN}/${username}/status/${id}`
}

/**
 * The directory and URL segment an account's files live under. Lowercased: Twitter treats
 * `MThorr` and `mthorr` as one account, a filesystem and a URL path do not, and a media
 * URL that stops working because somebody typed the name in the other case is not a
 * failure worth having.
 */
export function mediaDirFor(username: string): string {
  return username.toLowerCase()
}

/** Where an archived file is served from. Route: src/activitypub/archive-media.ts. */
export function mediaUrl(baseUrl: string, username: string, file: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/archive/media/twitter/${mediaDirFor(username)}/${file}`
}

// ---------------------------------------------------------------------------
// Text: full_text + entities → HTML
// ---------------------------------------------------------------------------

type Part =
  | { kind: 'text'; value: string }
  | { kind: 'link'; href: string }
  | { kind: 'mention'; screenName: string }
  | { kind: 'hashtag'; tag: string }
  | { kind: 'media' }

interface Span {
  start: number
  end: number
  part: Part
}

/**
 * Twitter HTML-escapes exactly three characters in `full_text`, and only those three.
 * Decoded here once and re-escaped by the HTML builder, so `&amp;` in the archive arrives
 * as `&amp;` in the content — and a tweet that literally says "&amp;" (stored as
 * `&amp;amp;`) survives as the four characters it was.
 */
function unescapeTwitter(s: string): string {
  return s.replace(/&(amp|lt|gt);/g, (_, e: string) => (e === 'amp' ? '&' : e === 'lt' ? '<' : '>'))
}

/**
 * The entity spans of one tweet, checked against the text they claim to cover.
 *
 * Indices count Unicode code points into `full_text` as exported (escapes and all) —
 * verified on both archives: all 32,844 url/media/hashtag/mention entities land exactly.
 * They are still checked, every one, because the alternative to checking is rendering a
 * link over the wrong word, silently. A span that does not match is dropped and counted;
 * the text underneath stays as plain text and the tweet is still imported.
 */
function collectSpans(cps: string[], entities: AnyObject, mismatches: string[]): Span[] {
  const spans: Span[] = []

  const add = (e: AnyObject, part: Part, matches: (covered: string) => boolean, label: string) => {
    const idx = Array.isArray(e.indices) ? e.indices : []
    const start = num(idx[0])
    const end = num(idx[1])
    if (start == null || end == null || start < 0 || end > cps.length || start >= end) {
      mismatches.push(`${label}: indices out of range`)
      return
    }
    if (!matches(cps.slice(start, end).join(''))) {
      mismatches.push(`${label}: text at ${start}-${end} does not match`)
      return
    }
    spans.push({ start, end, part })
  }

  const list = (k: string): AnyObject[] => (Array.isArray(entities[k]) ? (entities[k] as AnyObject[]) : [])

  for (const e of list('urls')) {
    const url = str(e.url)
    add(e, { kind: 'link', href: str(e.expanded_url) || url }, (c) => c === url, 'url')
  }
  for (const e of list('media')) {
    const url = str(e.url)
    add(e, { kind: 'media' }, (c) => c === url, 'media')
  }
  for (const e of list('hashtags')) {
    const tag = str(e.text)
    add(e, { kind: 'hashtag', tag }, (c) => c.toLowerCase() === `#${tag}`.toLowerCase(), 'hashtag')
  }
  for (const e of list('user_mentions')) {
    const sn = str(e.screen_name)
    add(e, { kind: 'mention', screenName: sn }, (c) => c.toLowerCase() === `@${sn}`.toLowerCase(), 'mention')
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  // Overlap would emit the same characters twice. Entities do not overlap in practice;
  // if one ever does, the first wins and the other is plain text again.
  const kept: Span[] = []
  for (const s of spans) {
    const last = kept[kept.length - 1]
    if (last && s.start < last.end) {
      mismatches.push('overlapping entity dropped')
      continue
    }
    kept.push(s)
  }
  return kept
}

function partsFor(fullText: string, entities: AnyObject, mismatches: string[]): Part[] {
  const cps = Array.from(fullText)
  const parts: Part[] = []
  let cursor = 0
  for (const span of collectSpans(cps, entities, mismatches)) {
    if (span.start > cursor) parts.push({ kind: 'text', value: unescapeTwitter(cps.slice(cursor, span.start).join('')) })
    parts.push(span.part)
    cursor = span.end
  }
  if (cursor < cps.length) parts.push({ kind: 'text', value: unescapeTwitter(cps.slice(cursor).join('')) })
  return parts
}

/** `https://www.example.com/a` → the part Mastodon shows, with the scheme kept hidden. */
function linkHtml(href: string): string {
  const m = href.match(/^(https?:\/\/)(.*)$/i)
  const scheme = m ? m[1]! : ''
  const rest = m ? m[2]! : href
  return (
    `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer" target="_blank">` +
    `<span class="invisible">${escapeHtml(scheme)}</span><span class="">${escapeHtml(rest)}</span></a>`
  )
}

/**
 * Tweet text as the Mastodon-flavoured HTML every other post in `objects.content` is.
 *
 * Links are written the way Mastodon writes them (scheme in an `invisible` span) so that
 * `stripHtml` — which is how `content_text` is derived for every post, boosted or pushed —
 * yields the full URL and not a bare hostname: the plain text is what search reads, and a
 * search for a link has to find it.
 *
 * Media links are removed. The photo or video is an attachment, and the `t.co` URL that
 * Twitter appends to the text for it is a pointer to the page that showed the same thing.
 * What it leaves behind is trimmed, so a picture tweet with no words has empty content
 * instead of a trailing space.
 */
export function renderTweetHtml(fullText: string, entities: AnyObject, mismatches: string[] = []): string {
  const inline = partsFor(fullText, entities, mismatches)
    .map((p) => {
      switch (p.kind) {
        case 'text':
          return escapeHtml(p.value)
        case 'link':
          return linkHtml(p.href)
        case 'media':
          return ''
        case 'mention':
          return (
            `<span class="h-card"><a href="https://${TWITTER_DOMAIN}/${escapeHtml(p.screenName)}" ` +
            `class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@<span>${escapeHtml(p.screenName)}</span></a></span>`
          )
        case 'hashtag':
          return (
            `<a href="https://${TWITTER_DOMAIN}/hashtag/${encodeURIComponent(p.tag)}" ` +
            `class="mention hashtag" rel="tag">#<span>${escapeHtml(p.tag)}</span></a>`
          )
      }
    })
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim()

  if (!inline) return ''
  return inline
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// ---------------------------------------------------------------------------
// Tweet → ActivityPub object
// ---------------------------------------------------------------------------

export interface TweetContext {
  account: TwitterAccount
  /** Scheme + host the archived files are served from (no trailing slash needed). */
  baseUrl: string
  /** Every account id imported in this run → its current username, so a reply to the
   *  other of Markus' two accounts points at a tweet that is actually here. */
  knownAccounts: ReadonlyMap<string, string>
  /** Whether `data/tweet_media/<file>` exists in the archive. */
  hasMedia: (file: string) => boolean
}

export interface BuiltTweet {
  /** The `objects.type`: `Note`, or `Announce` for a retweet. */
  type: 'Note' | 'Announce'
  apId: string
  object: AnyObject
  /** Names under `data/tweet_media/` this tweet's attachments are served from. */
  mediaFiles: string[]
  /** Attachments whose file the archive does not hold; they point at the original CDN. */
  missingMedia: string[]
  /** Entities the text did not agree with, dropped to plain text. */
  mismatches: string[]
}

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Twitter's language codes are mostly ISO 639-1. The two that are not: `in` is the retired
 * code for Indonesian, `iw` for Hebrew — and `und` means "no language could be detected",
 * which is the absence of an answer and must not be stored as one.
 */
export function normaliseLang(lang: unknown): string | null {
  if (typeof lang !== 'string') return null
  const l = lang.trim().toLowerCase()
  if (!l || l === 'und' || l === 'zxx') return null
  if (l === 'in') return 'id'
  if (l === 'iw') return 'he'
  return l
}

/**
 * A native or hand-typed retweet: the text starts `RT @user`.
 *
 * Text, not entities: the 2009 retweets typed by hand ("RT @HerbSommerfeld Interesting…")
 * and the ones whose original author has since vanished carry no mention entity at all —
 * about 20 of the 3,800 in the first archive — and they are retweets all the same.
 */
export function isRetweet(tweet: AnyObject): boolean {
  return /^RT @\w/.test(str(tweet.full_text))
}

/** The mp4 worth keeping: highest bitrate wins. (A GIF has a single variant, bitrate 0.) */
function bestMp4(media: AnyObject): AnyObject | null {
  const variants = (((media.video_info as AnyObject | undefined)?.variants ?? []) as AnyObject[])
    .filter((v) => v.content_type === 'video/mp4' && str(v.url))
  if (variants.length === 0) return null
  return variants.reduce((a, b) => ((num(b.bitrate) ?? 0) > (num(a.bitrate) ?? 0) ? b : a))
}

function fileNameOf(url: string): string {
  try {
    return basename(new URL(url).pathname)
  } catch {
    return basename(url)
  }
}

function buildAttachments(
  tweet: AnyObject,
  ctx: TweetContext,
  mediaFiles: string[],
  missingMedia: string[],
): AnyObject[] {
  const id = str(tweet.id_str)
  const list = (((tweet.extended_entities as AnyObject | undefined)?.media ??
    (tweet.entities as AnyObject | undefined)?.media ?? []) as AnyObject[])

  const out: AnyObject[] = []
  for (const m of list) {
    const isVideo = m.type === 'video' || m.type === 'animated_gif'
    const mp4 = isVideo ? bestMp4(m) : null
    const sourceUrl = isVideo ? str(mp4?.url) : str(m.media_url_https) || str(m.media_url)
    if (!sourceUrl) continue

    const name = fileNameOf(sourceUrl)
    const file = `${id}-${name}`
    const mediaType = isVideo ? 'video/mp4' : (IMAGE_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream')

    const archived = ctx.hasMedia(file)
    if (archived) mediaFiles.push(file)
    else missingMedia.push(file)

    const large = ((m.sizes as AnyObject | undefined)?.large ?? {}) as AnyObject
    const durationMs = isVideo ? num((m.video_info as AnyObject | undefined)?.duration_millis) : null
    const poster = isVideo ? strOrNull(m.media_url_https) : null
    const att: AnyObject = {
      // `Document` is what Mastodon sends for every kind of media; `mediaType` is what
      // everything downstream actually branches on.
      type: 'Document',
      mediaType,
      // Served from here when the archive holds the file; otherwise the original CDN
      // address, which may be dead but is the only honest pointer left.
      url: archived ? mediaUrl(ctx.baseUrl, ctx.account.username, file) : sourceUrl,
      // Twitter's alt text, when the author wrote any. Never invented.
      name: strOrNull(m.ext_alt_text),
      width: num(large.w),
      height: num(large.h),
      sourceUrl,
      archived,
    }
    if (m.type === 'animated_gif') att.animatedGif = true
    // The still frame (a remote thumbnail: the archive does not hold it) and the length,
    // in the spellings the stream's attachment reader already understands.
    if (poster) att.icon = { type: 'Image', url: poster }
    if (durationMs != null) att.duration = `PT${durationMs / 1000}S`
    out.push(att)
  }
  return out
}

/**
 * Who a reply is addressed to, as a profile URL, and the tweet it answers, as a URL.
 *
 * A reply to one of the two imported accounts points at that account's *current* name,
 * because that is the `ap_id` its tweets are filed under here; a reply to anyone else
 * points at the screen name the tweet recorded, which is the name of the day and as close
 * as the archive gets. With no name at all Twitter's own `i/web/status/<id>` form still
 * resolves, so the thread is never left without its parent.
 */
function replyTarget(tweet: AnyObject, ctx: TweetContext): { inReplyTo: string; toActor: string | null } | null {
  const statusId = str(tweet.in_reply_to_status_id_str)
  if (!statusId) return null

  const userId = str(tweet.in_reply_to_user_id_str)
  const mentions = (((tweet.entities as AnyObject | undefined)?.user_mentions ?? []) as AnyObject[])
  const name =
    ctx.knownAccounts.get(userId) ??
    strOrNull(tweet.in_reply_to_screen_name) ??
    strOrNull(mentions.find((m) => str(m.id_str) === userId)?.screen_name)

  return name
    ? { inReplyTo: tweetUrl(name, statusId), toActor: actorApId(name) }
    : { inReplyTo: `https://${TWITTER_DOMAIN}/i/web/status/${statusId}`, toActor: null }
}

function generatorOf(source: unknown): AnyObject | null {
  const s = str(source)
  if (!s) return null
  const name = s.replace(/<[^>]+>/g, '').trim()
  const href = s.match(/href="([^"]*)"/i)?.[1] ?? null
  if (!name && !href) return null
  return { type: 'Application', name, ...(href ? { url: href } : {}) }
}

/**
 * One tweet as a Note (or, for a retweet, an Announce) shaped like Mastodon's, plus the
 * list of files it needs.
 *
 * Retweets are the one place the archive is thinner than the model. An ActivityPub boost
 * points at the object it boosts; a 2020 export of a retweet carries only the truncated
 * "RT @user: …" text, with no id for the original. So they are stored as what they are —
 * the retweet, in the account's own timeline, with the original author as a Mention — under
 * the type `Announce`, where `object_types: ["Note"]` leaves them out and the default
 * keeps them. When the retweet had a picture, the picture entity does name the original
 * tweet, and `object` points at it. See ADR 0067.
 */
export function tweetToObject(tweet: AnyObject, ctx: TweetContext): BuiltTweet {
  const id = str(tweet.id_str)
  if (!id) throw new Error('tweet has no id_str')
  const published = parseTwitterDate(tweet.created_at)
  if (!published) throw new Error(`tweet ${id} has no parseable created_at (${String(tweet.created_at)})`)

  const { account } = ctx
  const apId = tweetUrl(account.username, id)
  const actor = actorApId(account.username)
  const entities = (tweet.entities ?? {}) as AnyObject
  const fullText = str(tweet.full_text) || str(tweet.text)

  const mismatches: string[] = []
  const content = renderTweetHtml(fullText, entities, mismatches)

  const mediaFiles: string[] = []
  const missingMedia: string[] = []
  const attachment = buildAttachments(tweet, ctx, mediaFiles, missingMedia)

  const reply = replyTarget(tweet, ctx)
  const retweet = isRetweet(tweet)

  // Tags: the shapes `hashtag-stats` and the `tag=` filter already read.
  const tag: AnyObject[] = []
  for (const h of (entities.hashtags ?? []) as AnyObject[]) {
    const t = str(h.text)
    if (t) tag.push({ type: 'Hashtag', href: `https://${TWITTER_DOMAIN}/hashtag/${encodeURIComponent(t)}`, name: `#${t}` })
  }
  const mentioned = new Set<string>()
  for (const m of (entities.user_mentions ?? []) as AnyObject[]) {
    const sn = str(m.screen_name)
    if (!sn) continue
    const href = actorApId(ctx.knownAccounts.get(str(m.id_str)) ?? sn)
    mentioned.add(href)
    tag.push({ type: 'Mention', href, name: `@${sn}@${TWITTER_DOMAIN}` })
  }
  if (reply?.toActor) mentioned.add(reply.toActor)
  mentioned.delete(actor)

  const lang = normaliseLang(tweet.lang)
  const coords = ((tweet.coordinates as AnyObject | undefined)?.coordinates ?? null) as unknown[] | null
  // GeoJSON order: [longitude, latitude]. (`geo` is the deprecated mirror, latitude first.)
  const lon = coords ? num(coords[0]) : null
  const lat = coords ? num(coords[1]) : null

  const likes = num(tweet.favorite_count)
  const shares = num(tweet.retweet_count)
  const generator = generatorOf(tweet.source)

  // Retweets of a picture carry the original's id on the picture entity.
  const srcMedia = ((tweet.extended_entities as AnyObject | undefined)?.media ??
    (entities.media ?? [])) as AnyObject[]
  const srcStatus = retweet ? srcMedia.find((m) => str(m.source_status_id_str)) : undefined
  const srcUser = srcStatus ? str(srcStatus.source_user_id_str) : ''
  const srcName = srcStatus
    ? ctx.knownAccounts.get(srcUser) ??
      strOrNull((entities.user_mentions as AnyObject[] | undefined)?.find((m) => str(m.id_str) === srcUser)?.screen_name)
    : null
  const announced = srcStatus
    ? tweetUrl(srcName ?? 'i/web', str(srcStatus.source_status_id_str))
    : null

  const type: 'Note' | 'Announce' = retweet ? 'Announce' : 'Note'

  const object: AnyObject = {
    '@context': AS_CONTEXT,
    id: apId,
    type,
    attributedTo: actor,
    published,
    to: [PUBLIC],
    cc: [...mentioned],
    url: apId,
    content,
    ...(lang ? { contentMap: { [lang]: content } } : {}),
    ...(reply ? { inReplyTo: reply.inReplyTo } : {}),
    ...(announced ? { object: announced } : {}),
    sensitive: tweet.possibly_sensitive === true,
    ...(attachment.length ? { attachment } : {}),
    ...(tag.length ? { tag } : {}),
    ...(lat != null && lon != null ? { location: { type: 'Place', latitude: lat, longitude: lon } } : {}),
    ...(generator ? { generator } : {}),
    ...(likes != null ? { likes: { type: 'Collection', totalItems: likes } } : {}),
    ...(shares != null ? { shares: { type: 'Collection', totalItems: shares } } : {}),
    // The tweet exactly as exported. Nothing above is allowed to be the only copy.
    twitterArchive: { accountId: account.accountId, username: account.username, tweet },
  }

  return { type, apId, object, mediaFiles, missingMedia, mismatches }
}

// ---------------------------------------------------------------------------
// Account → ActivityPub Person
// ---------------------------------------------------------------------------

export interface BuiltActor {
  apId: string
  handle: string
  username: string
  domain: string
  displayName: string
  summaryHtml: string
  iconUrl: string | null
  raw: AnyObject
  /** Files under `data/profile_media/` to serve, by role. */
  profileFiles: { avatar: string | null; header: string | null }
}

/**
 * The file in `data/profile_media/` for a profile image, or null.
 *
 * The export names them `<accountId>-<last path segment of the CDN url>`, and the segment
 * is not always a filename: an avatar's is (`MOE8nvM7.png`), a banner's is a bare
 * timestamp (`1405196721`) that the export gave a `.jpg` of its own. So the match is on the
 * prefix, with or without an extension.
 */
export function profileMediaFile(account: TwitterAccount, url: string | null, present: ReadonlySet<string>): string | null {
  if (!url) return null
  const stem = `${account.accountId}-${fileNameOf(url)}`
  if (present.has(stem)) return stem
  for (const f of present) if (f.startsWith(`${stem}.`)) return f
  return null
}

/**
 * The account as a Person.
 *
 * `publicKeyPem` and `inbox` do not exist and are not invented: there is no server to
 * receive anything and no key to sign with, and a made-up inbox URL is a promise this
 * account cannot keep. They are empty strings at the row level (the columns are NOT NULL)
 * and absent from the document.
 */
export function buildActor(
  account: TwitterAccount,
  baseUrl: string,
  profileFiles: ReadonlySet<string>,
): BuiltActor {
  const apId = actorApId(account.username)
  const avatar = profileMediaFile(account, account.avatarUrl, profileFiles)
  const header = profileMediaFile(account, account.headerUrl, profileFiles)

  const summaryHtml = account.bio
    ? account.bio
        .trim()
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : ''

  const fields: AnyObject[] = []
  if (account.location) fields.push({ type: 'PropertyValue', name: 'Location', value: escapeHtml(account.location) })
  if (account.website) fields.push({ type: 'PropertyValue', name: 'Website', value: escapeHtml(account.website) })

  // Served from here when the archive holds the file, otherwise Twitter's own address.
  const iconUrl = avatar ? mediaUrl(baseUrl, account.username, avatar) : account.avatarUrl
  const imageUrl = header ? mediaUrl(baseUrl, account.username, header) : account.headerUrl

  const raw: AnyObject = {
    '@context': AS_CONTEXT,
    id: apId,
    type: 'Person',
    preferredUsername: account.username,
    name: account.displayName,
    url: apId,
    ...(summaryHtml ? { summary: summaryHtml } : {}),
    ...(account.createdAt ? { published: account.createdAt } : {}),
    ...(iconUrl ? { icon: { type: 'Image', url: iconUrl } } : {}),
    ...(imageUrl ? { image: { type: 'Image', url: imageUrl } } : {}),
    ...(fields.length ? { attachment: fields } : {}),
    twitterArchive: {
      accountId: account.accountId,
      createdVia: account.createdVia,
      screenNameChanges: account.screenNameChanges,
      timeZone: account.timeZone,
      verified: account.verified,
      avatarSourceUrl: account.avatarUrl,
      headerSourceUrl: account.headerUrl,
    },
  }

  return {
    apId,
    handle: actorHandle(account.username),
    username: account.username,
    domain: TWITTER_DOMAIN,
    displayName: account.displayName,
    summaryHtml,
    iconUrl,
    raw,
    profileFiles: { avatar, header },
  }
}
