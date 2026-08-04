/**
 * When a stream entry actually happened.
 *
 * The stream is ordered by the event's own date, not by when Markus posted about
 * it: a film marked yesterday but watched in 2016 belongs in 2016. Each lane has
 * its own idea of that date, and they are not interchangeable — ADR 0012 exists
 * because `neodb_marks.watched_at` (the shelf date) and `published_at` (when the
 * mark federated) can be a decade apart.
 *
 * An entry with no derivable date is excluded from the stream entirely. That keeps
 * `(event_at DESC, ref_id DESC)` a strict total order, which is what makes the
 * keyset pagination correct — with nullable dates the ordering has a tail whose
 * membership changes as rows are added, and a cursor into it skips or repeats rows.
 */

/** Markus lives here, and the day a scrobble belongs to is the day he experienced. */
export const STREAM_TIMEZONE = 'Europe/Oslo'

/**
 * The Oslo calendar day a moment falls on, as `YYYY-MM-DD`.
 *
 * Uses Intl rather than arithmetic on a fixed offset: Norway is UTC+1 in winter and
 * UTC+2 in summer, so a play at 23:30 UTC on 30 June is 01:30 on 1 July locally,
 * while the same clock time in January is still 00:30 on the 31st. Getting this
 * wrong misfiles a digest by a day twice a year, silently.
 */
const OSLO_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: STREAM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function osloDay(at: Date): string {
  return OSLO_YMD.format(at)
}

const OSLO_WALL = new Intl.DateTimeFormat('en-CA', {
  timeZone: STREAM_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** How far ahead of UTC Oslo's wall clock is at `at`, in milliseconds. */
function osloOffsetMs(at: Date): number {
  const p: Record<string, string> = {}
  for (const part of OSLO_WALL.formatToParts(at)) p[part.type] = part.value
  // `hour12: false` reports midnight as "24" in some ICU builds.
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  return wallAsUtc - at.getTime()
}

/**
 * The instant at which an Oslo month begins — midnight local, not midnight UTC.
 *
 * The stream renders every date in Oslo (`entry.tsx`) and files scrobble digests by
 * Oslo day, so a UTC month boundary puts entries in an archive month that
 * contradicts the date printed on them. In summer the last two hours of a UTC month
 * are already the next month in Oslo: a post at `2026-06-30T23:30Z` reads "1. juli"
 * on the page and belonged to `/arkiv/2026/06`. The scrobble lane made it worse —
 * its `event_at` *is* Oslo midnight, so the digest for the 1st of every month landed
 * in the previous month's archive, every month, all year.
 *
 * Derived through `Intl` rather than a fixed +01:00/+02:00 because the offset
 * depends on the date. The second pass covers the case where the first guess lands
 * on the other side of a DST transition; month boundaries never do (Norway switches
 * at 02:00/03:00 on a Sunday, never at midnight on the 1st), but the correction is
 * cheap and the function should not quietly depend on that.
 */
export function osloMonthStart(year: number, month: number): Date {
  const wall = Date.UTC(year, month - 1, 1)
  const first = osloOffsetMs(new Date(wall))
  const utc = wall - first
  const second = osloOffsetMs(new Date(utc))
  return new Date(second === first ? utc : wall - second)
}

/**
 * Parse a hand-written garden frontmatter date. These are authored by hand and vary
 * in precision — "2024", "2024-03", "2024-03-11", and occasionally a full timestamp.
 * A partial date resolves to the start of its period; anything unparseable is null,
 * which drops the note from the stream rather than placing it at the epoch.
 */
export function parsePartialDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null

  // ISO 8601 shapes only. `new Date(s)` on arbitrary text is worse than useless
  // here: it reads "11.03.2024" — Norwegian for 11 March — as 3 November, and
  // nothing downstream would ever notice. If we cannot recognise the shape, we
  // do not have a date.
  let iso: string
  if (/^\d{4}$/.test(s)) iso = `${s}-01-01T00:00:00Z`
  else if (/^\d{4}-\d{2}$/.test(s)) iso = `${s}-01T00:00:00Z`
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) iso = s.replace(' ', 'T')
  else return null

  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  // A frontmatter typo like "0202-03-11" is a plausible slip and would sort to the
  // very bottom of the archive forever. Treat an implausible year as unparseable.
  const year = at.getUTCFullYear()
  if (year < 1900 || year > 2200) return null
  return at
}

/** Pick the first usable date, in order of authority. */
function firstDate(...candidates: Array<Date | string | null | undefined>): Date | null {
  for (const c of candidates) {
    if (c instanceof Date) {
      if (!Number.isNaN(c.getTime())) return c
      continue
    }
    const parsed = parsePartialDate(c)
    if (parsed) return parsed
  }
  return null
}

/**
 * A NeoDB mark's date. `watched_at` is the shelf date — when Markus says he saw,
 * read or played it — and it wins over the date the mark federated (ADR 0012).
 */
export function markEventDate(row: {
  watchedAt: Date | null
  publishedAt: Date | null
}): Date | null {
  return firstDate(row.watchedAt, row.publishedAt)
}

/**
 * A BookWyrm reading event's date. Started/finished events carry the reader's own
 * dates on the AP object; everything else is placed by when it was posted.
 */
export function readingEventDate(row: {
  eventType: string
  startedDate?: string | null
  finishedDate?: string | null
  publishedAt: Date | null
}): Date | null {
  if (row.eventType === 'started_reading') return firstDate(row.startedDate, row.publishedAt)
  if (row.eventType === 'finished_reading') return firstDate(row.finishedDate, row.publishedAt)
  return firstDate(row.publishedAt)
}

/** A garden note's date, from its frontmatter; undated notes are excluded. */
export function gardenEventDate(row: { noteDate: string | null }): Date | null {
  return parsePartialDate(row.noteDate)
}

/**
 * Order two entries as the stream does: newest first, ties broken by ref_id
 * descending, byte-wise.
 *
 * This must agree exactly with the SQL `ORDER BY event_at DESC, ref_id DESC
 * COLLATE "C"` — the merge of the per-lane candidate sets is sorted in JS, and if
 * the two disagree the page boundary lands in a different place than the cursor
 * expects. `COLLATE "C"` is why the comparison here is `<`/`>` on the raw string
 * rather than localeCompare.
 */
export function compareEntries(
  a: { eventAt: Date; refId: string },
  b: { eventAt: Date; refId: string },
): number {
  const at = b.eventAt.getTime() - a.eventAt.getTime()
  if (at !== 0) return at
  if (a.refId === b.refId) return 0
  return a.refId < b.refId ? 1 : -1
}
