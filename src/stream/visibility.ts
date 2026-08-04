import { sql, type SQL } from 'drizzle-orm'
import { objects } from '../db/schema.js'

/**
 * Who an archived post was addressed to at its origin — the gate that decides
 * what may appear on the public stream at meg.msge.no.
 *
 * The archive holds posts the bot received as an *accepted follower* of Markus'
 * accounts, so followers-only posts really are in `objects`. Nothing here may be
 * published unless the origin server said it was public. See ADR 0017.
 *
 * ActivityStreams addresses an object with `to`/`cc`, and every platform we follow
 * (Mastodon, Pixelfed, Loops, BookWyrm, NeoDB) uses the same four-level convention:
 *
 *   public          to: [Public]        cc: [followers]
 *   unlisted        to: [followers]     cc: [Public]
 *   followers-only  to: [followers]     cc: []
 *   direct          to: [actor, …]      cc: []
 *
 * Three lexical forms of the Public marker are legal depending on how the sender
 * compacted its JSON-LD, and either field may be a bare string rather than an array.
 *
 * FAIL CLOSED is the load-bearing property. Only an explicit Public marker in `to`
 * yields 'public'. An object we cannot read addressing from at all is 'unknown',
 * which is *not* publishable — a parsing gap must cost us a post on the page, never
 * leak one. `classifyVisibility` is mirrored by the generated column defined in
 * `drizzle/0020_objects_visibility.sql`; change one and you must change the other.
 */
export type Visibility = 'public' | 'unlisted' | 'private' | 'unknown'

/** The Public marker, in every form a compliant sender may compact it to. */
const PUBLIC_MARKERS: readonly string[] = [
  'https://www.w3.org/ns/activitystreams#Public',
  'as:Public',
  'Public',
]

/**
 * Mirrors Postgres jsonb containment of a scalar: a bare string matches on
 * equality, an array matches on membership. Anything else (null, number, object)
 * matches nothing.
 */
function addressesPublic(field: unknown): boolean {
  if (typeof field === 'string') return PUBLIC_MARKERS.includes(field)
  if (Array.isArray(field)) {
    return field.some((v) => typeof v === 'string' && PUBLIC_MARKERS.includes(v))
  }
  return false
}

export function classifyVisibility(raw: unknown): Visibility {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown'
  const obj = raw as Record<string, unknown>

  // Own properties only. `raw->'to'` in Postgres reads the key that is actually
  // there, so a prototype-chain lookup here would let the two implementations
  // disagree — and disagree in the dangerous direction, since an inherited `to`
  // would read as public.
  const to = Object.hasOwn(obj, 'to') ? obj.to : undefined
  const cc = Object.hasOwn(obj, 'cc') ? obj.cc : undefined

  if (addressesPublic(to)) return 'public'
  if (addressesPublic(cc)) return 'unlisted'
  // Addressing is present but names no public audience: followers-only or direct.
  if (Object.hasOwn(obj, 'to') || Object.hasOwn(obj, 'cc')) return 'private'
  // No addressing at all — a bare or stripped object. We cannot prove it was
  // public, so it is not.
  return 'unknown'
}

/** True only for values safe to render on a public page. */
export function isPublishable(v: Visibility): boolean {
  return v === 'public'
}

/**
 * The WHERE fragment every stream lane must carry. Kept as a function rather than a
 * constant so each call site reads as a deliberate act, and so the SQL-shape tests can
 * assert its presence per lane.
 *
 * `includeUnlisted` exists for STREAM_INCLUDE_UNLISTED and defaults off: an unlisted
 * post was deliberately withheld from public timelines at the origin, and republishing
 * it on an indexed page would override that choice.
 */
export function publicOnlyCondition(includeUnlisted = false): SQL {
  return includeUnlisted
    ? sql`${objects.visibility} IN ('public', 'unlisted')`
    : sql`${objects.visibility} = 'public'`
}

/**
 * The same rule, written against a table alias.
 *
 * `publicOnlyCondition` emits drizzle's fully-qualified `"objects"."visibility"`,
 * which is right inside a query-builder call but wrong inside the hand-written lane
 * SQL, where the table is aliased (`FROM objects o`) and `objects` is not in scope
 * at all. Postgres rejects it outright — and in a correlated subquery that aliases
 * the same table twice, a stray qualified reference silently resolves to the *outer*
 * row instead, which is worse than an error.
 */
export function publicOnlyOn(alias: string, includeUnlisted = false): SQL {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) {
    throw new Error(`Unusable SQL alias: ${alias}`)
  }
  const col = sql.raw(`${alias}.visibility`)
  return includeUnlisted
    ? sql`${col} IN ('public', 'unlisted')`
    : sql`${col} = 'public'`
}
