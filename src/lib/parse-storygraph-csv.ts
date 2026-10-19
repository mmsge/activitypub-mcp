import { parse } from 'csv-parse/sync'
import { normalizeIsbn, isbn10to13, isValidIsbn13 } from './isbn.js'

/**
 * StoryGraph's library export (Manage account → Export StoryGraph library), reduced to
 * what the read-dates import needs. See ADR 0063.
 *
 * Deliberately narrow: moods, pace, the character questions, content warnings, owned
 * status, the review and the star rating are all in the file and none of them are read.
 * They are not carried in `raw` either, so nothing here can leak them into the store.
 */

/** One pass through a book, as StoryGraph lists it in `Dates Read`. */
export interface StorygraphReadRange {
  /** `YYYY-MM-DD`, the local day StoryGraph shows. Null when only the finish is known. */
  started: string | null
  /** `YYYY-MM-DD`. Null when only the start is known. */
  finished: string | null
}

export interface StorygraphCsvRow {
  title: string
  authors: string[]
  /** A valid ISBN-13 (an ISBN-10 is expanded). Null for StoryGraph's own uids. */
  isbn13: string | null
  /** The `ISBN/UID` cell as given, for the report. */
  uid: string | null
  readStatus: string | null
  /** Every read, oldest first, duplicates removed. Empty for a book never read. */
  reads: StorygraphReadRange[]
  /** The `Dates Read` cell as given, so a range that failed to parse is reportable. */
  datesReadRaw: string | null
  /** Ranges in `Dates Read` that were not dates at all. */
  unparsed: string[]
}

const REQUIRED = ['Title', 'Authors', 'Dates Read'] as const

const str = (v: string | undefined): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * `2024/03/15` (StoryGraph's own shape) or `2024-03-15` → `2024-03-15`, or null when it
 * is not a real calendar day. Never passed through a Date in a zone: the value is
 * already the day StoryGraph shows, and validation uses UTC only to ask whether
 * 2024-02-30 exists.
 */
export function parseStorygraphDay(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (!m) return null
  const [, y, mo, d] = m
  // JavaScript accepts year 0000; Postgres DATE does not, and one bad cell would abort
  // the whole import's transaction.
  if (Number(y) < 1000) return null
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  const probe = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== iso) return null
  return iso
}

/**
 * The `Dates Read` cell: comma-separated ranges, each `start-finish`, a lone day
 * (StoryGraph knows only the finish), or a half-open range. Returns the parsed ranges,
 * oldest first with exact duplicates dropped, and whatever could not be read.
 *
 * A reversed range (finish before start) is reported, not swapped: guessing which end
 * is wrong would invent a date.
 */
export function parseDatesRead(cell: string | null): { reads: StorygraphReadRange[]; unparsed: string[] } {
  const reads: StorygraphReadRange[] = []
  const unparsed: string[] = []
  if (!cell) return { reads, unparsed }

  for (const part of cell.split(',').map((p) => p.trim()).filter(Boolean)) {
    // Dates are written with slashes, so a hyphen here is the range separator. An ISO
    // day (with hyphens) is accepted only on its own, never inside a range.
    const pieces = part.includes('/') ? part.split('-').map((p) => p.trim()) : [part]
    let range: StorygraphReadRange | null = null
    if (pieces.length === 1) {
      const day = parseStorygraphDay(pieces[0])
      if (day) range = { started: null, finished: day }
    } else if (pieces.length === 2) {
      const started = pieces[0] ? parseStorygraphDay(pieces[0]) : null
      const finished = pieces[1] ? parseStorygraphDay(pieces[1]) : null
      const startOk = pieces[0] === '' || started !== null
      const finishOk = pieces[1] === '' || finished !== null
      if (startOk && finishOk && (started || finished) && !(started && finished && started > finished)) {
        range = { started, finished }
      }
    }
    if (range) reads.push(range)
    else unparsed.push(part)
  }

  const seen = new Set<string>()
  const unique = reads.filter((r) => {
    const k = rangeKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => (a.started ?? a.finished ?? '').localeCompare(b.started ?? b.finished ?? ''))
  return { reads: unique, unparsed }
}

/** The identity of one read within a book: both ends, either of which may be absent. */
export const rangeKey = (r: StorygraphReadRange): string => `${r.started ?? ''}..${r.finished ?? ''}`

/** The `ISBN/UID` cell as an ISBN-13, or null for a StoryGraph uid or a bad checksum. */
export function storygraphIsbn13(cell: string | null): string | null {
  const s = normalizeIsbn(cell)
  if (!s) return null
  if (s.length === 10) return isbn10to13(s)
  return isValidIsbn13(s) ? s : null
}

/**
 * Parse a StoryGraph library export. Throws when the header lacks the columns this
 * import depends on, so a different CSV (a Goodreads export, the trips file) is refused
 * outright rather than read as a library with no dates in it.
 */
export function parseStorygraphCsv(text: string): StorygraphCsvRow[] {
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[]

  if (records.length > 0) {
    const missing = REQUIRED.filter((c) => !(c in records[0]))
    if (missing.length) throw new Error(`CSV missing required column(s): ${missing.join(', ')}`)
  }

  const rows: StorygraphCsvRow[] = []
  for (const r of records) {
    const title = str(r['Title'])
    if (!title) continue
    const datesReadRaw = str(r['Dates Read'])
    let { reads, unparsed } = parseDatesRead(datesReadRaw)
    // Older exports have no `Dates Read` for a single read, only `Last Date Read`.
    if (reads.length === 0 && unparsed.length === 0) {
      const last = str(r['Last Date Read'])
      const day = last ? parseStorygraphDay(last) : null
      if (day) reads = [{ started: null, finished: day }]
    }
    const uid = str(r['ISBN/UID'])
    rows.push({
      title,
      authors: (str(r['Authors']) ?? '').split(',').map((a) => a.trim()).filter(Boolean),
      isbn13: storygraphIsbn13(uid),
      uid,
      readStatus: str(r['Read Status']),
      reads,
      datesReadRaw,
      unparsed,
    })
  }
  return rows
}
