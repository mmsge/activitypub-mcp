/**
 * The join key between LinkedIn's two sources.
 *
 * Post content comes from the DMA Member Snapshot API; post performance comes from
 * the monthly .xlsx. Both carry "the post URL", but not the same string for the
 * same post:
 *
 *   API:    https://www.linkedin.com/feed/update/urn:li:activity:7463140292985032705
 *   export: https://www.linkedin.com/posts/markus-mg_ki-buzzwords-ugcPost-7462903540748034050-dUyv
 *
 * Both embed the same numeric id, so that id is the key and the URLs are kept
 * verbatim beside it. This is string canonicalisation, not URN resolution — no
 * network call, no mapping table. If the two forms ever do agree it costs nothing;
 * while they don't, it is the difference between the join working and matching zero
 * rows silently.
 */

/**
 * LinkedIn ids are 19-digit snowflakes today, but nothing documents that width, so
 * match a run of digits long enough not to collide with the slug's own numbers
 * (`markus-mg_2024-...`) and short enough not to care when the width changes.
 */
const MIN_ID_DIGITS = 12

/**
 * `urn:li:activity:123`, `urn:li:share:123`, `urn:li:ugcPost:123` — the URN form,
 * however it is spelled and whether or not it has been percent-encoded.
 */
const URN_RE = /urn(?::|%3A)li(?::|%3A)(?:activity|share|ugcPost|fsd_update)(?::|%3A)(\d{12,})/i

/**
 * The share-permalink form: a slug ending in `-activity-<id>-<hash>` or
 * `-ugcPost-<id>-<hash>`. Anchored on the type word so a numeric run inside the
 * slug itself cannot win.
 */
const PERMALINK_RE = /-(?:activity|ugcPost|share)-(\d{12,})/i

/** Last resort: any sufficiently long digit run left in the URL. */
const BARE_ID_RE = /(\d{12,})/

/**
 * The canonical post key for a LinkedIn URL, or null when no id can be found.
 *
 * Accepts a bare id too, so a caller can pass either a URL or a key to the
 * get-one MCP tool without having to know which it holds.
 */
export function canonicalPostKey(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null

  // A bare id, passed straight through by a caller who already has the key.
  if (new RegExp(`^\\d{${MIN_ID_DIGITS},}$`).test(raw)) return raw

  for (const re of [URN_RE, PERMALINK_RE, BARE_ID_RE]) {
    const m = re.exec(raw)
    if (m) return m[1]
  }
  return null
}

/**
 * The canonical permalink for a key — what to show when the two sources disagree
 * on spelling. `/feed/update/urn:li:activity:<id>` is LinkedIn's own stable form
 * and resolves for share and ugcPost ids alike.
 */
export function canonicalPostUrl(postKey: string): string {
  return `https://www.linkedin.com/feed/update/urn:li:activity:${postKey}`
}
