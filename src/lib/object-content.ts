type AnyObject = Record<string, unknown>

/**
 * The HTML body of an ActivityPub object. Most implementations put it in
 * `content`, but some (Mastodon forks, Peertube, …) only populate the
 * language-keyed `contentMap` — fall back to its first string value so those
 * posts don't get stored with empty text.
 */
export function extractContent(obj: AnyObject): string | null {
  if (typeof obj.content === 'string' && obj.content) return obj.content
  const map = obj.contentMap
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const v of Object.values(map as AnyObject)) {
      if (typeof v === 'string' && v) return v
    }
  }
  return null
}
