type AnyObject = Record<string, unknown>

/**
 * Structured fields of an ActivityPub object that can change when the author
 * edits a post: its media, its hashtags/mentions, the language, the CW flag.
 *
 * These live in their own module because more than one place must derive them
 * identically: the Create ingest, the Update (edit) handler, the Announce
 * (boost) store, and the one-time re-derivation backfill. Keeping a single
 * implementation is what stops the edit path and the create path from drifting
 * — the exact drift that once let an edited post keep stale `tags` (a hashtag
 * added in an edit never reached the `tag=` filter) while its text updated.
 *
 * All pure: given the raw object, they return the value to store. Kept out of
 * the handlers (which need the db) so they can be unit-tested on their own.
 */

/** `attachment` normalized to an array (AP allows a single object or a list). */
export function extractAttachments(obj: AnyObject): unknown[] {
  const a = obj.attachment
  if (!a) return []
  return Array.isArray(a) ? a : [a]
}

/** `tag` normalized to an array (Hashtag/Mention/Emoji entries; single or list). */
export function extractTags(obj: AnyObject): unknown[] {
  const t = obj.tag
  if (!t) return []
  return Array.isArray(t) ? t : [t]
}

/** First key of `contentMap` as a best-effort language tag, else null. */
export function extractLanguage(obj: AnyObject): string | null {
  const ct = obj.contentMap as Record<string, string> | null
  if (ct && typeof ct === 'object' && !Array.isArray(ct)) return Object.keys(ct)[0] ?? null
  return null
}
