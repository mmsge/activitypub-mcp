/**
 * Reading LinkedIn's snapshotData without letting its shape reach the database.
 *
 * The Member Snapshot API returns each record as a JSON object whose keys are
 * human-readable strings with spaces — `"First Name"`, `"Shared URL"`. LinkedIn
 * documents the key list for exactly one domain (PROFILE, in a sample response)
 * and for none of the others, and the endpoint is pinned to version 202312
 * forever, so there is no version bump that would signal a rename. Assuming an
 * exact key spelling is therefore a guess with no way to be told it broke.
 *
 * So: normalise every key to lowercase alphanumerics and resolve through an alias
 * table. `"Shared URL"`, `"SharedUrl"` and `"shared_url"` all land on the same
 * field, and the untouched record is stored alongside so a spelling nobody
 * anticipated is a re-parse over stored rows rather than a re-fetch behind a token
 * that may since have expired.
 */

/** Lowercase alphanumerics only: `"Share Commentary"` → `sharecommentary`. */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Re-key a record by its normalised keys, keeping the first spelling that wins. */
export function normaliseRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    const nk = normaliseKey(k)
    if (!(nk in out)) out[nk] = v
  }
  return out
}

/**
 * The first non-empty value among the given aliases, as a trimmed string.
 * Aliases are normalised here so callers can write them readably.
 */
export function pick(
  record: Record<string, unknown>,
  ...aliases: string[]
): string | null {
  for (const alias of aliases) {
    const v = record[normaliseKey(alias)]
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s !== '') return s
  }
  return null
}

/**
 * LinkedIn spells booleans as "Yes"/"No" and "true"/"false" depending on the
 * domain. Anything unrecognised is false rather than null — a reshare flag that
 * cannot be read is not evidence of a reshare.
 */
export function pickBoolean(
  record: Record<string, unknown>,
  ...aliases: string[]
): boolean {
  const v = pick(record, ...aliases)
  if (v === null) return false
  return ['yes', 'true', '1', 'y'].includes(v.toLowerCase())
}

/**
 * A date from snapshotData, as a Date, or null.
 *
 * MEMBER_SHARE_INFO stamps dates as `"2026-05-21 08:04:13"` — no zone marker. Read
 * naively that is parsed as local time by `new Date()`, which on a UTC container
 * and a CEST author is a two-hour drift; enough to move a post posted at 08:04
 * into the previous weekday bucket if it were near midnight. Assume UTC for the
 * zoneless form, and let anything already carrying a zone parse as given.
 */
export function pickDate(
  record: Record<string, unknown>,
  ...aliases: string[]
): Date | null {
  const v = pick(record, ...aliases)
  if (!v) return null

  const zoneless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(v)
  const iso = zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : v

  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}
