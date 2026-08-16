/**
 * Parse a Google Takeout-shaped `watch-history.json` into watch-event rows.
 *
 * Pure: takes already-parsed entries, returns rows and problems, touches neither the
 * network nor the database — mirroring parse-linkedin-export.ts and parse-trips-csv.ts,
 * whose importers this one's importer also mirrors.
 *
 * The schema is Takeout's, so one ingest path serves both the My Activity console scrape
 * and any real Takeout export. Extra keys beyond Takeout's schema (`account`,
 * `durationSeconds`, `unresolved`, `source`) are additive; a Takeout reader ignores them
 * and this reader supplies defaults when they are absent.
 *
 * Three things about this format produce wrong data if skimmed:
 *
 *   **`time` is a bare local wall clock.** Europe/Oslo, no offset, minute resolution,
 *   seconds always `00`. It is returned here as the source's own string and stored
 *   verbatim; resolving it to an instant is the database's job, not this module's, so
 *   nothing can accidentally reinterpret it as UTC on the way through. See ADR 0047.
 *
 *   **`durationSeconds` is the VIDEO's length, not the watch's.** Neither Takeout nor My
 *   Activity records how much of a video was watched, only that it was opened. Nothing
 *   downstream may treat this as time spent.
 *
 *   **The natural key is (account, video id, time), and all three parts are required.**
 *   Videos are legitimately rewatched, one minute legitimately holds many different
 *   videos, and two accounts can hold the same video in the same minute. `dedupeKey`
 *   carries exactly that triple.
 *
 * Nothing is dropped silently. Every entry either becomes a row or becomes a
 * `ParseProblem` with a named reason, and `rows.length + problems.length === total`.
 */

/**
 * A video at or under this many seconds is treated as a Short.
 *
 * There is no Shorts flag anywhere in Takeout or the YouTube API, so duration is the
 * practical heuristic and 180s is where YouTube itself drew the line. A row with NO
 * duration is UNKNOWN — neither Short nor long-form — and must never be silently bucketed
 * as either.
 */
export const SHORTS_MAX_SECONDS = 180

/**
 * Ceiling for the capped watch-time estimate, in seconds.
 *
 * Since no watch duration exists, a raw sum of video lengths counts an eight-hour stream
 * that was open for two minutes as eight hours. Capping each row at 20 minutes gives a
 * second, differently-wrong figure; quoting both is more honest than choosing one.
 */
export const WATCH_TIME_CAP_SECONDS = 1200

/** The prefix Takeout puts on every watch entry's title. */
const WATCHED_PREFIX = 'Watched '

/** Wall clock as delivered: `YYYY-MM-DDTHH:MM:SS`, optionally with a sub-second part. */
const LOCAL_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/

/** YouTube video ids are exactly 11 characters of the URL-safe base64 alphabet. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Channel ids are `UC` followed by 22 more characters. */
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/

export interface WatchRow {
  account: string
  videoId: string
  videoUrl: string
  /** The source's wall clock, verbatim: `YYYY-MM-DDTHH:MM:SS`. Never an instant. */
  watchedAtLocal: string
  /** Title with the "Watched " prefix stripped. Null when unresolved. */
  title: string | null
  channelName: string | null
  /** UC… id from the channel URL. Null when unresolved or when given an @handle URL. */
  channelId: string | null
  /** The VIDEO's length in seconds. Null when the source did not resolve one. */
  durationSeconds: number | null
  /** Terminal: a deleted, private or otherwise unavailable video. */
  unresolved: boolean
  source: string
  raw: unknown
  /** `account|videoId|watchedAtLocal` — the natural key, for in-file deduplication. */
  dedupeKey: string
}

/** An entry that could not be turned into a row. Counted and surfaced, never swallowed. */
export interface ParseProblem {
  /** Position in the source array, so a bad entry can be found in the file. */
  index: number
  reason: string
  /** A short, identifying excerpt — enough to locate the entry without dumping it. */
  sample: string
}

/**
 * A value the parser changed on the way through, and what it changed it to.
 *
 * Distinct from a ParseProblem: the row is kept. But the archive no longer says exactly
 * what the source said, so the caller is told rather than left to discover it.
 */
export interface ParseNormalisation {
  index: number
  kind: string
  from: string
  to: string
}

export interface ParseResult {
  total: number
  rows: WatchRow[]
  problems: ParseProblem[]
  /** Values the parser altered. Reported, never silent. */
  normalisations: ParseNormalisation[]
}

export interface ParseOptions {
  /** Used when an entry carries no `account`. Absent + absent is a problem, not a guess. */
  defaultAccount?: string
  /** Used when an entry carries no `source`. Absent + absent is a problem, not a guess. */
  defaultSource?: string
}

/**
 * The 11-character video id from a watch URL.
 *
 * Three spellings, in priority order: `watch?v=<id>` (id in any query position),
 * `/shorts/<id>`, and the short `youtu.be/<id>` form. Returns null rather than guessing —
 * a URL shape we do not recognise must surface as a problem, not become a row keyed on a
 * wrong id.
 *
 * The `youtu.be` pattern is deliberately unanchored, and that is load-bearing rather than
 * lazy. The archive contains watch entries whose `titleUrl` is a SEARCH RESULTS page whose
 * query is itself a shortened link:
 *
 *   https://www.youtube.com/results?search_query=https://youtu.be/<id>%3Fsi%3D…
 *
 * The video is the one named inside, and the reference implementation that produced the
 * archive resolves it the same way — anchoring here would reject those rows and leave the
 * import two watches short of the source. `?v=` is tried first, so an ordinary watch URL
 * can never be misread by this branch.
 */
export function extractVideoId(url: string): string | null {
  const fromQuery = /[?&]v=([^&#]+)/.exec(url)
  const candidate = fromQuery?.[1]
    ?? /\/shorts\/([^/?#]+)/.exec(url)?.[1]
    ?? /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(url)?.[1]
  if (!candidate) return null
  // Ids are already URL-safe, but the source has been through a console export; a
  // percent-encoded one would otherwise fail the length check for the wrong reason.
  let decoded = candidate
  try {
    decoded = decodeURIComponent(candidate)
  } catch {
    // Malformed escape sequence — fall through and let the shape check reject it.
  }
  return VIDEO_ID_RE.test(decoded) ? decoded : null
}

/**
 * The UC… channel id from a channel URL.
 *
 * Null for the `/@handle` and `/c/<name>` spellings, which carry no id. That is a real
 * absence, not a failure: the display name is still captured, and a future enrichment
 * pass can resolve the id from the video.
 */
export function extractChannelId(url: string): string | null {
  const id = /\/channel\/([^/?#]+)/.exec(url)?.[1]
  return id && CHANNEL_ID_RE.test(id) ? id : null
}

/** Strip Takeout's "Watched " prefix. Returns the title unchanged if it is absent. */
export function stripWatchedPrefix(title: string): string {
  return title.startsWith(WATCHED_PREFIX) ? title.slice(WATCHED_PREFIX.length) : title
}

/** Build the natural key. Exported so the importer and its tests agree on one spelling. */
export function watchDedupeKey(account: string, videoId: string, watchedAtLocal: string): string {
  return `${account}|${videoId}|${watchedAtLocal}`
}

/** Whether a duration classifies as a Short. Null (unknown) is never a Short. */
export function isShort(durationSeconds: number | null): boolean {
  return durationSeconds !== null && durationSeconds < SHORTS_MAX_SECONDS
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/**
 * Normalise the wall clock to `YYYY-MM-DDTHH:MM:SS`.
 *
 * Deliberately rejects anything carrying a timezone offset or a trailing `Z`. Such a value
 * is not the local wall clock this pipeline is built on, and silently dropping the offset
 * would shift the row by an unknown amount — exactly the failure the two-column storage
 * exists to prevent.
 *
 * Shape only. Whether the value is a REAL date and time is a separate question — see
 * isRealLocalTime.
 */
function normaliseLocalTime(raw: string): string | null {
  const m = LOCAL_TIME_RE.exec(raw.trim())
  return m ? `${m[1]}T${m[2]}` : null
}

/**
 * The greatest hour an "extended hour" timestamp may carry.
 *
 * 24-47 means "this many hours into the stated day", i.e. the small hours of the day
 * after. 48 would be two days out, which no such notation means and which is far more
 * likely to be corruption than a convention.
 */
export const MAX_EXTENDED_HOUR = 47

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

const formatLocal = (at: Date): string =>
  `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
  `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`

/**
 * Turn a shape-valid wall clock into the moment it denotes, or null if it denotes none.
 *
 * Two jobs, because `\d{2}:\d{2}:\d{2}` matches strings that are not times.
 *
 * **Range.** February 30th, month 13 and minute 60 are rejected. The check is a
 * round-trip through Date.UTC: JavaScript ROLLS OVER an out-of-range component rather
 * than refusing it, so comparing every component back is what catches them.
 *
 * **Extended hours.** The archive contains one entry stamped `2025-05-19T30:30:00`. Hour
 * 30 is not an hour, but 24-47 is the well-known "this many hours into the stated day"
 * notation, and here it is corroborated rather than assumed: the export is ordered
 * strictly newest-first, and that entry sits between 14:28 on the 19th and 07:51 on the
 * 20th — exactly where 06:30 on the 20th belongs, and nowhere else. So it is rolled into
 * the following day and the caller is TOLD, via ParseResult.normalisations. Declared,
 * never silent; the import prints it on its own line.
 *
 * Only the hour may be extended. A minute of 60 or a February 30th is corruption with no
 * such convention behind it and stays a rejection.
 */
export function resolveLocalTime(local: string): { local: string; rolled: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local)
  if (!m) return null
  const [y, mo, d, hh, mi, ss] = m.slice(1).map(Number) as [number, number, number, number, number, number]

  if (mi > 59 || ss > 59 || hh > MAX_EXTENDED_HOUR) return null

  // The calendar date must be real on its own terms, before any hour is applied.
  const day = new Date(Date.UTC(y, mo - 1, d))
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return null
  }

  if (hh < 24) return { local, rolled: false }

  // Date.UTC does the rollover, which is what makes month and year boundaries correct:
  // 30:30 on the 31st lands on the 1st of the next month, and on 31 December in the next
  // year, without any arithmetic here to get wrong.
  return { local: formatLocal(new Date(Date.UTC(y, mo - 1, d, hh, mi, ss))), rolled: true }
}

/**
 * Parse watch-history entries into rows.
 *
 * Order is preserved, and every input index appears in exactly one of `rows` or
 * `problems`, so the caller can always account for all `total` entries.
 */
export function parseYoutubeWatchHistory(
  entries: unknown[],
  opts: ParseOptions = {},
): ParseResult {
  const rows: WatchRow[] = []
  const problems: ParseProblem[] = []
  const normalisations: ParseNormalisation[] = []

  entries.forEach((entry, index) => {
    const problem = (reason: string, sample: string) => {
      problems.push({ index, reason, sample: sample.slice(0, 120) })
    }

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problem('entry is not an object', JSON.stringify(entry) ?? String(entry))
      return
    }
    const e = entry as Record<string, unknown>

    // A merged or full Takeout file can carry YouTube Music rows and search rows. They
    // are valid data about something else, so they are reported rather than absorbed.
    const header = str(e.header)
    if (header !== 'YouTube') {
      problem(`header is not "YouTube" (got ${header ?? 'nothing'})`, JSON.stringify(e.title ?? ''))
      return
    }

    const rawTitle = str(e.title)
    if (!rawTitle) {
      problem('no title', JSON.stringify(e.titleUrl ?? ''))
      return
    }
    // Takeout emits "Viewed …", "Searched for …" and similar under the same header.
    // Only "Watched …" is a watch event.
    if (!rawTitle.startsWith(WATCHED_PREFIX)) {
      problem('title is not a watch event', rawTitle)
      return
    }

    const titleUrl = str(e.titleUrl)
    // Real Takeout carries entries with no titleUrl at all ("Watched a video that has
    // been removed"). There is no video identity to key on, so they cannot be stored.
    if (!titleUrl) {
      problem('no titleUrl', rawTitle)
      return
    }
    const videoId = extractVideoId(titleUrl)
    if (!videoId) {
      problem('no video id in titleUrl', titleUrl)
      return
    }

    const rawTime = str(e.time)
    if (!rawTime) {
      problem('no time', titleUrl)
      return
    }
    const shaped = normaliseLocalTime(rawTime)
    if (!shaped) {
      problem('time is not a bare local wall clock', rawTime)
      return
    }
    // Shape is not validity. Resolved here rather than left to fail inside Postgres tens
    // of thousands of rows into an insert.
    const resolved = resolveLocalTime(shaped)
    if (!resolved) {
      problem('time is not a real date or time', rawTime)
      return
    }
    if (resolved.rolled) {
      normalisations.push({
        index,
        kind: 'extended hour rolled into the following day',
        from: shaped,
        to: resolved.local,
      })
    }
    const watchedAtLocal = resolved.local

    const account = str(e.account) ?? opts.defaultAccount
    if (!account) {
      problem('no account, and no default supplied', titleUrl)
      return
    }

    const source = str(e.source) ?? opts.defaultSource
    if (!source) {
      problem('no source, and no default supplied', titleUrl)
      return
    }

    // Unresolved is declared by the flag, and corroborated by the shape: the source puts
    // the bare URL where the title belongs. Either signal is enough, so a file that
    // carries only one of the two still lands the row in the right terminal state.
    const stripped = stripWatchedPrefix(rawTitle)
    const unresolved = e.unresolved === true || stripped === titleUrl

    let durationSeconds: number | null = null
    if (e.durationSeconds !== undefined && e.durationSeconds !== null) {
      const d = e.durationSeconds
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0) {
        problem('durationSeconds is not a non-negative integer', JSON.stringify(d))
        return
      }
      durationSeconds = d
    }

    // subtitles[0] is the channel. Absent for unresolved videos, and skipped entirely for
    // them regardless, since a channel on an unresolved row would contradict its state.
    let channelName: string | null = null
    let channelId: string | null = null
    if (!unresolved && Array.isArray(e.subtitles) && e.subtitles.length > 0) {
      const first = e.subtitles[0]
      if (typeof first === 'object' && first !== null) {
        const s = first as Record<string, unknown>
        channelName = str(s.name)
        const channelUrl = str(s.url)
        channelId = channelUrl ? extractChannelId(channelUrl) : null
      }
    }

    rows.push({
      account,
      videoId,
      videoUrl: titleUrl,
      watchedAtLocal,
      title: unresolved ? null : stripped,
      channelName,
      channelId,
      durationSeconds,
      unresolved,
      source,
      raw: entry,
      dedupeKey: watchDedupeKey(account, videoId, watchedAtLocal),
    })
  })

  return { total: entries.length, rows, problems, normalisations }
}

/** Problem counts by reason, newest-largest first — what the importer prints. */
export function summariseProblems(problems: ParseProblem[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>()
  for (const p of problems) counts.set(p.reason, (counts.get(p.reason) ?? 0) + 1)
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}
