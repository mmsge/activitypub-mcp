/**
 * Find the links in a tweet that point at a pre-2011 photo host: Twitpic, yfrog,
 * Twitgoo, TweetPhoto/Plixi/Lockerz and early Instagram.
 *
 * Before Twitter hosted pictures itself, a photo tweet was text plus a link to one of
 * these. All of them are gone now, so the archive export holds the link and nothing
 * else; the picture only survives in the Wayback Machine. This module answers the first
 * half of recovering it: which links are photo links, and which URLs might have held
 * the image file. src/lib/wayback.ts does the second half. See ADR 0068.
 *
 * Pure, so the host rules are unit-tested without touching the network.
 */

type AnyObject = Record<string, unknown>

export type LegacyHost = 'twitpic' | 'yfrog' | 'twitgoo' | 'plixi' | 'instagram'

export interface LegacyImageLink {
  host: LegacyHost
  /** The host's own id for the photo, as it appears in the link. */
  id: string
  /** The link normalised to one spelling, used to download each photo only once. */
  url: string
}

/**
 * The live page for a link, on hosts still serving their photos. Twitpic went read-only
 * rather than dark in 2014 and still serves each photo page, with a signed, expiring
 * image link, so the page is read fresh every time. Null for hosts that are gone.
 */
export function livePageFor(link: LegacyImageLink): string | null {
  return link.host === 'twitpic' ? `https://twitpic.com/${link.id}` : null
}

/** A URL that may have held the photo, and how to look it up in the Wayback index. */
export interface Candidate {
  url: string
  /** `exact` looks up this URL; `prefix` looks up every URL starting with it. */
  match: 'exact' | 'prefix'
  /** `image` is the file itself; `page` is HTML to find the image link in. */
  kind: 'image' | 'page'
}

interface HostRule {
  host: LegacyHost
  pattern: RegExp
  normalise: (id: string) => string
}

// Each pattern matches the link with or without scheme and www, and captures the id.
// The id stops at anything that is not a letter, digit, - or _, which is where a tweet's
// punctuation starts ("http://twitpic.com/517yh." or "…/517yh)").
const RULES: HostRule[] = [
  { host: 'twitpic', pattern: /(?:https?:\/\/)?(?:www\.)?twitpic\.com\/(?!show\/|photos\/)([a-z0-9]+)/gi, normalise: (id) => `https://twitpic.com/${id.toLowerCase()}` },
  { host: 'yfrog', pattern: /(?:https?:\/\/)?(?:www\.)?yfrog\.(?:com|us)\/([a-z0-9]+)/gi, normalise: (id) => `https://yfrog.com/${id}` },
  { host: 'twitgoo', pattern: /(?:https?:\/\/)?(?:www\.)?twitgoo\.com\/([a-z0-9]+)/gi, normalise: (id) => `https://twitgoo.com/${id}` },
  { host: 'plixi', pattern: /(?:https?:\/\/)?(?:www\.)?(?:plixi\.com\/p|lockerz\.com\/s|tweetphoto\.com)\/([0-9]+)/gi, normalise: (id) => `https://plixi.com/p/${id}` },
  { host: 'instagram', pattern: /(?:https?:\/\/)?(?:www\.)?(?:instagr\.am|instagram\.com)\/p\/([a-z0-9_-]+)/gi, normalise: (id) => `https://instagram.com/p/${id}/` },
]

/**
 * A link Twitter cut short when it truncated a long retweet to fit 140 characters: `http://twitpic.com/2 ...`
 * or `…/3…`. The id is a fragment of a real one, and looking it up finds a stranger's
 * photo, so it is dropped.
 */
function isTruncated(text: string, end: number): boolean {
  // Only retweets were cut short; in his own tweet a link followed by "..." is whole.
  if (!/^RT\s/.test(text)) return false
  const after = text.slice(end, end + 4)
  return /^\s?(?:\.\.\.|…)/.test(after)
}

/**
 * Twitpic's ids were already four base-36 characters by its launch in 2008, so a shorter
 * one is a fragment, not a photo.
 */
const MIN_ID_LENGTH: Partial<Record<LegacyHost, number>> = { twitpic: 4 }

/** Every legacy photo link in one string, in order of appearance, without repeats. */
export function findLegacyLinks(text: string): LegacyImageLink[] {
  const found: Array<LegacyImageLink & { at: number }> = []
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const id = m[1]
      if (isTruncated(text, (m.index ?? 0) + m[0].length)) continue
      if (id.length < (MIN_ID_LENGTH[rule.host] ?? 1)) continue
      found.push({ host: rule.host, id, url: rule.normalise(id), at: m.index ?? 0 })
    }
  }
  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: LegacyImageLink[] = []
  for (const { at: _at, ...link } of found) {
    if (seen.has(link.url)) continue
    seen.add(link.url)
    out.push(link)
  }
  return out
}

/**
 * The legacy photo links in a tweet from the archive export.
 *
 * Looks at both the text and the expanded URLs: a 2009 tweet has the twitpic link in its
 * text, a 2012 one has a t.co link there and the twitpic link only in
 * `entities.urls[].expanded_url`.
 */
export function legacyLinksInTweet(tweet: AnyObject): LegacyImageLink[] {
  const parts: string[] = []
  if (typeof tweet.full_text === 'string') parts.push(tweet.full_text)
  else if (typeof tweet.text === 'string') parts.push(tweet.text)
  const urls = ((tweet.entities as AnyObject | undefined)?.urls ?? []) as AnyObject[]
  for (const u of urls) {
    if (typeof u.expanded_url === 'string') parts.push(u.expanded_url)
  }
  return findLegacyLinks(parts.join(' '))
}

/**
 * Twitpic's short ids are the photo's number in base 36, and the image files were stored
 * by that number. Null if the id is not plain base 36.
 */
export function twitpicNumber(id: string): string | null {
  if (!/^[0-9a-z]+$/i.test(id)) return null
  let n = 0n
  for (const ch of id.toLowerCase()) n = n * 36n + BigInt(parseInt(ch, 36))
  return n.toString()
}

/**
 * The URLs to try for one link, best first.
 *
 * Image URLs come first because a hit there is the file itself. The page comes last: it
 * is the most likely to have been captured, but it costs a second lookup for the image
 * it points at. The storage paths for Twitpic are the ones ArchiveTeam's 2014 rescue
 * crawled, on the CloudFront host the live site still serves from; they are tried as
 * prefixes because the file extension is not known.
 */
export function candidatesFor(link: LegacyImageLink): Candidate[] {
  const { host, id } = link
  const img = (url: string, match: Candidate['match'] = 'exact'): Candidate => ({ url, match, kind: 'image' })
  const page = (url: string): Candidate => ({ url, match: 'exact', kind: 'page' })
  switch (host) {
    case 'twitpic': {
      const num = twitpicNumber(id)
      const stored = num
        ? [
            img(`dn3pm25xmtlyu.cloudfront.net/photos/full/${num}.`, 'prefix'),
            img(`dn3pm25xmtlyu.cloudfront.net/photos/large/${num}.`, 'prefix'),
            img(`s3.amazonaws.com/twitpic/photos/full/${num}.`, 'prefix'),
            img(`s3.amazonaws.com/twitpic/photos/large/${num}.`, 'prefix'),
          ]
        : []
      return [img(`twitpic.com/show/full/${id}`), img(`twitpic.com/show/large/${id}`), ...stored, page(`twitpic.com/${id}`)]
    }
    case 'yfrog':
      return [img(`yfrog.com/${id}:medium`), img(`yfrog.com/${id}:iphone`), page(`yfrog.com/${id}`)]
    case 'twitgoo':
      return [img(`twitgoo.com/${id}/img`), img(`twitgoo.com/show/img/${id}`), page(`twitgoo.com/${id}`)]
    case 'plixi':
      return [page(`plixi.com/p/${id}`), page(`lockerz.com/s/${id}`), page(`tweetphoto.com/${id}`)]
    case 'instagram':
      return [img(`instagr.am/p/${id}/media/?size=l`), img(`instagram.com/p/${id}/media/?size=l`), page(`instagram.com/p/${id}/`), page(`instagr.am/p/${id}/`)]
  }
}

/**
 * The image a photo page points at: `og:image`, `twitter:image`, `image_src`, or the
 * main photo element on the hosts that had one, or with `anyImg` the first image on the
 * page. Relative links are resolved against the page. Null when the page names no image.
 */
export function imageUrlFromPage(html: string, pageUrl: string, opts: { anyImg?: boolean } = {}): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+(?:content|value)=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<img[^>]+id=["'](?:photo-display|main_image|photo)["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+id=["'](?:photo-display|main_image|photo)["']/i,
    // Twitpic today serves a bare page with one unlabelled <img>, so for a page known to
    // be a single photo the first image is the photo.
    ...(opts.anyImg ? [/<img[^>]+src=["']([^"']+)["']/i] : []),
  ]
  for (const p of patterns) {
    const m = html.match(p)
    if (!m) continue
    const raw = m[1].replace(/&amp;/g, '&')
    try {
      return new URL(raw, pageUrl.startsWith('http') ? pageUrl : `http://${pageUrl}`).toString()
    } catch {
      continue
    }
  }
  return null
}

/** A file extension for an image content type, or `bin` when it is not one we know. */
export function extensionFor(contentType: string | null): string {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  }
  return map[t] ?? 'bin'
}
