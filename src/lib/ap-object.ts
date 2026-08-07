// Pure helpers for reading the shape of an ActivityPub object reference.
//
// ActivityStreams lets almost every property be a bare URI string, an embedded object,
// or a list of either. The inbox handlers all need the same three answers — what is this
// object's id, who authored it, and is this a real object or just a pointer — so they
// live here, pure and unit-tested, rather than being re-guessed per handler.

type AnyObject = Record<string, unknown>

/** The `id` of an AP object (`@id` for a JSON-LD-expanded payload), else null. */
export function objectApId(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as AnyObject
  const id = o.id ?? o['@id']
  return typeof id === 'string' && id.trim() ? id : null
}

/**
 * A link-valued property resolved to a URI: `"https://…"`, `{ id: "https://…" }`, a
 * `Link` (`{ href: "https://…" }`), or the first entry of a list of any of those. Used
 * for `actor` / `attributedTo` / `url` / `inReplyTo`, which one implementation sends as a
 * plain string and the next as an embedded object — storing the object verbatim in a text
 * column is how a `url` ends up as "[object Object]".
 */
export function resolveRef(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null
  if (Array.isArray(v)) {
    for (const entry of v) {
      const r = resolveRef(entry)
      if (r) return r
    }
    return null
  }
  const id = objectApId(v)
  if (id) return id
  const href = (v as AnyObject | null)?.href
  return typeof href === 'string' && href.trim() ? href : null
}

/**
 * The first absolute http(s) URL inside a value that may be a string, an object with
 * `url`/`href`, or an array of either.
 *
 * Narrower than `resolveRef` in what it accepts (a scheme is required, so a bare id
 * that happens to be a URN is rejected) and wider in where it looks (it descends
 * through `url`/`href` rather than stopping at the first entry). For the properties
 * that name a *picture* — a video's `icon`/`preview`/`image`, a custom emoji's
 * `icon` — where servers disagree on all three shapes and the cost of not accepting
 * them is an image that silently never renders.
 */
export function firstHttpUrl(raw: unknown): string | null {
  const candidates = Array.isArray(raw) ? raw : [raw]
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c
    if (c && typeof c === 'object') {
      const o = c as AnyObject
      const nested = firstHttpUrl(o.url ?? o.href)
      if (nested) return nested
    }
  }
  return null
}

/**
 * True when an object carries nothing worth storing beyond its identity — no text, no
 * media, no tags, no timestamp. A boost can embed such a stub instead of the post
 * itself; storing it would create a contentless row (and, on a re-ingest, overwrite a
 * good one), so the caller resolves the id over the network first.
 */
export function isBareReference(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return true
  const o = obj as AnyObject
  const hasText = Boolean(o.content) || Boolean(o.contentMap) || Boolean(o.summary)
  const hasStructure = Boolean(o.tag) || Boolean(o.attachment) || Boolean(o.relatedWith)
  return !hasText && !hasStructure && !o.published
}
