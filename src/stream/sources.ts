/**
 * Where the public stream's entries come from, and what each one is called.
 *
 * Two kinds of source feed meg.msge.no:
 *
 *  - The five ActivityPub accounts Markus owns, listed explicitly in STREAM_SOURCES.
 *    They are an allowlist, not a convenience. `objects` is NOT "Markus' posts": the
 *    Announce handler unwraps a boost and files the inner object under its *original
 *    author*, so the archive contains strangers' posts too. Deriving the set from
 *    `actors.software` would sweep those in — and `software` is nullable besides.
 *
 *  - Three local sources that never came over ActivityPub at all: Last.fm scrobbles,
 *    the viaduct.world train trips, and the markus.plus garden notes. Nothing to
 *    allowlist there; they are only ever Markus'.
 */

/** The five federated platforms. A closed set — an unrecognised slug is a config error. */
export const AP_PLATFORMS = ['mastodon', 'bookwyrm', 'pixelfed', 'loops', 'neodb', 'rullen'] as const
export type ApPlatform = (typeof AP_PLATFORMS)[number]

/** Local, non-federated sources. Always present; not configurable. */
export const LOCAL_PLATFORMS = ['lastfm', 'tog', 'hage'] as const
export type LocalPlatform = (typeof LOCAL_PLATFORMS)[number]

export type Platform = ApPlatform | LocalPlatform

/**
 * A lane is one query against one table shape. Lanes are disjoint by actor, which
 * is what stops a post being counted twice: BookWyrm's actor only ever produces
 * `reading` rows, NeoDB's only `marks`, and the remaining three only `posts`.
 */
export type Lane = 'posts' | 'reading' | 'marks' | 'music' | 'trips' | 'garden'

/** Every kind of entry the stream can render. The view layer dispatches on this. */
export const KINDS = [
  'post', 'photo', 'video',
  'book_started', 'book_finished', 'book_comment', 'book_review', 'book_quote',
  'screen', 'listen', 'play', 'read_neodb', 'mark',
  'scrobble_day', 'trip', 'garden',
] as const
export type Kind = (typeof KINDS)[number]

export interface PlatformInfo {
  platform: Platform
  lane: Lane
  /** Shown on the entry's source badge, and as the filter's own name. */
  label: string
  /** Nynorsk for the "read it there" link: "Les på BookWyrm". */
  linkLabel: string
}

const PLATFORM_INFO: Record<Platform, Omit<PlatformInfo, 'platform'>> = {
  mastodon: { lane: 'posts', label: 'Mastodon', linkLabel: 'Mastodon' },
  pixelfed: { lane: 'posts', label: 'Pixelfed', linkLabel: 'Pixelfed' },
  loops: { lane: 'posts', label: 'Loops', linkLabel: 'Loops' },
  // Markus' own ActivityPub server (software name "rullen"), for railway clips.
  rullen: { lane: 'posts', label: 'Rullen', linkLabel: 'Rullen' },
  bookwyrm: { lane: 'reading', label: 'BookWyrm', linkLabel: 'BookWyrm' },
  neodb: { lane: 'marks', label: 'NeoDB', linkLabel: 'NeoDB' },
  lastfm: { lane: 'music', label: 'Musikk', linkLabel: 'Last.fm' },
  tog: { lane: 'trips', label: 'Tog', linkLabel: 'viaduct.world' },
  hage: { lane: 'garden', label: 'Hagen', linkLabel: 'markus.plus' },
}

export function platformInfo(p: Platform): PlatformInfo {
  return { platform: p, ...PLATFORM_INFO[p] }
}

export function isApPlatform(v: string): v is ApPlatform {
  return (AP_PLATFORMS as readonly string[]).includes(v)
}

export function isPlatform(v: string): v is Platform {
  return isApPlatform(v) || (LOCAL_PLATFORMS as readonly string[]).includes(v)
}

/** One configured ActivityPub account. `apId` is filled in once resolved. */
export interface ApSource {
  handle: string
  platform: ApPlatform
  apId: string | null
}

export class SourceConfigError extends Error {}

/**
 * Parse STREAM_SOURCES: a comma-separated list of `@user@domain|platform`.
 *
 * Strict on purpose. A typo here does not degrade the page, it changes which
 * accounts are publishable — so an unparseable entry throws at startup rather than
 * being skipped with a warning nobody reads.
 */
export function parseSources(raw: string): ApSource[] {
  const out: ApSource[] = []
  const seen = new Set<string>()

  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [handleRaw, platformRaw, ...rest] = entry.split('|').map((s) => s.trim())
    if (rest.length > 0 || !handleRaw || !platformRaw) {
      throw new SourceConfigError(
        `STREAM_SOURCES entry "${entry}" is malformed; expected "@user@domain|platform"`,
      )
    }
    if (!isApPlatform(platformRaw)) {
      throw new SourceConfigError(
        `STREAM_SOURCES entry "${entry}" names unknown platform "${platformRaw}"; expected one of ${AP_PLATFORMS.join(', ')}`,
      )
    }
    const handle = handleRaw.startsWith('@') ? handleRaw : `@${handleRaw}`
    if (!/^@[^@\s]+@[^@\s]+$/.test(handle)) {
      throw new SourceConfigError(
        `STREAM_SOURCES entry "${entry}" has no usable handle; expected "@user@domain"`,
      )
    }
    if (seen.has(handle.toLowerCase())) {
      throw new SourceConfigError(`STREAM_SOURCES lists ${handle} more than once`)
    }
    seen.add(handle.toLowerCase())
    out.push({ handle, platform: platformRaw, apId: null })
  }
  return out
}

/** The lanes a platform filter selects. Unfiltered ⇒ every lane. */
export function lanesForPlatform(p: Platform | null): Lane[] {
  if (p === null) return ['posts', 'reading', 'marks', 'music', 'trips', 'garden']
  return [platformInfo(p).lane]
}
