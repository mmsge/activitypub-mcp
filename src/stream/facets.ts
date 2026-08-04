import { KINDS, isPlatform, type Kind, type Platform } from './sources.js'
import { decodeCursor, InvalidCursorError, type SortOrder } from '../mcp/tools/pagination.js'

/**
 * How a request narrows the stream, and how that becomes a cache key.
 *
 * Everything here normalises to a closed set before it reaches SQL or the cache.
 * That is the actual defence for a public page: the page cache is keyed on these
 * values, so if an unrecognised filter were passed through, a crawler could mint
 * unbounded distinct cache entries just by varying the query string. Unknown
 * values are rejected outright (the router turns that into a 404) rather than
 * being ignored, which would silently serve the unfiltered page under a filtered
 * URL.
 *
 * There is no free-text search: Markus chose filters instead, which also keeps the
 * public surface small.
 */

export const PAGE_SIZE = 20

/** How many entries the front page shows before "vis meir". */
export const FRONT_PAGE_SIZE = 50

export interface Facets {
  platform: Platform | null
  kind: Kind | null
  tag: string | null
  /** Year and month for /arkiv/YYYY/MM. */
  year: number | null
  month: number | null
  cursor: string | null
  limit: number
  order: SortOrder
}

export const EMPTY_FACETS: Facets = {
  platform: null,
  kind: null,
  tag: null,
  year: null,
  month: null,
  cursor: null,
  limit: PAGE_SIZE,
  order: 'desc',
}

/** A filter value we do not recognise. The router answers 404. */
export class UnknownFacetError extends Error {}

export function parsePlatform(raw: string | undefined | null): Platform {
  const v = (raw ?? '').trim().toLowerCase()
  if (!isPlatform(v)) throw new UnknownFacetError(`Unknown source "${raw}"`)
  return v
}

export function parseKind(raw: string | undefined | null): Kind {
  const v = (raw ?? '').trim().toLowerCase()
  if (!(KINDS as readonly string[]).includes(v)) throw new UnknownFacetError(`Unknown kind "${raw}"`)
  return v as Kind
}

/** Hashtags compare case-insensitively with the leading '#' stripped. */
export function parseTag(raw: string | undefined | null): string {
  const v = (raw ?? '').trim().replace(/^#/, '').toLowerCase()
  // Bound the length and the alphabet: this reaches a LIKE and a cache key.
  if (!v || v.length > 100 || !/^[\p{L}\p{N}_]+$/u.test(v)) {
    throw new UnknownFacetError(`Unusable tag "${raw}"`)
  }
  return v
}

export function parseArchive(yearRaw: string, monthRaw: string): { year: number; month: number } {
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!/^\d{4}$/.test(yearRaw) || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new UnknownFacetError(`Unusable year "${yearRaw}"`)
  }
  if (!/^\d{1,2}$/.test(monthRaw) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new UnknownFacetError(`Unusable month "${monthRaw}"`)
  }
  return { year, month }
}

/**
 * The cursor, validated here rather than deep in the query so a bad token is a
 * 400 at the edge instead of a 500 from the database.
 */
export function parseCursor(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v.length > 512) throw new InvalidCursorError('Invalid cursor: too long')
  decodeCursor(v) // throws InvalidCursorError on anything malformed
  return v
}

/**
 * Half-open [start, end) bounds for an archive month, in UTC.
 *
 * The stream's dates are a mix of real timestamps and dates parsed from
 * day-precision strings normalised to UTC midnight, so the month boundary is UTC
 * too. Using Oslo local time here would pull the last hour of the previous month
 * into the page in summer.
 */
export function archiveRange(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1))
  return { start, end }
}

/**
 * A canonical string for the page cache.
 *
 * Order-insensitive by construction — the fields are written in a fixed order, so
 * `?a=1&b=2` and `?b=2&a=1` cannot become two entries for one page. `limit` is
 * included because the front page asks for more than a follow-on page, but it is
 * never client-settable, so it contributes a handful of values at most.
 */
export function cacheKey(f: Facets): string {
  return [
    f.platform ?? '-',
    f.kind ?? '-',
    f.tag ?? '-',
    f.year != null && f.month != null ? `${f.year}-${String(f.month).padStart(2, '0')}` : '-',
    f.cursor ?? '-',
    String(f.limit),
    f.order,
  ].join('|')
}
