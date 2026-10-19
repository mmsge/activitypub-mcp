import { normalizeTitle, type CollapsedBook, type ReadingCycle } from './bookwyrm-reading.js'
import type { StorygraphReadRange } from './parse-storygraph-csv.js'

/**
 * StoryGraph read dates folded into BookWyrm's derived reading cycles. See ADR 0063.
 *
 * BookWyrm stays the authority (ADR 0002): a date it has is never replaced. StoryGraph
 * fills what it lacks, which is mostly the start of a book that was shelved straight to
 * "read", and the whole of a reread nobody posted about. Pure, so the rules are tested
 * without a database.
 */

/** Days apart two finishes (or, failing those, two starts) may be and still be one read. */
export const PAIR_WINDOW_DAYS = 7

const DAY_MS = 86_400_000

/** A cycle date as the day the reading tools already print for it. */
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

/**
 * A StoryGraph day as a Date that prints back as the same day. Midnight UTC, because
 * every reading tool renders cycle dates with `toISOString().slice(0, 10)`.
 */
const fromDay = (s: string): Date => new Date(`${s}T00:00:00Z`)

const daysBetween = (a: string, b: string): number =>
  Math.abs(fromDay(a).getTime() - fromDay(b).getTime()) / DAY_MS

export interface StorygraphConflict {
  book: string | null
  field: 'started' | 'finished'
  bookwyrm: string
  storygraph: string
  /** Why StoryGraph's date was not used. */
  reason: 'disagree' | 'start_after_finish'
}

export interface MergeOutcome {
  book: CollapsedBook
  /** Starts StoryGraph supplied for a cycle BookWyrm already had. */
  startsFilled: number
  /** Finishes StoryGraph supplied for a cycle BookWyrm already had. */
  finishesFilled: number
  /** Reads BookWyrm had no cycle for at all, added whole. */
  readsAdded: number
  conflicts: StorygraphConflict[]
}

/**
 * How far apart a BookWyrm cycle and a StoryGraph read are, or null when they cannot be
 * the same pass. Finishes are compared when both have one; a cycle still open or put down
 * is compared on its start.
 */
function distance(c: ReadingCycle, r: StorygraphReadRange): number | null {
  const cf = day(c.finished)
  const cs = day(c.started)
  let d: number | null = null
  if (cf && r.finished) d = daysBetween(cf, r.finished)
  else if (cs && r.started) d = daysBetween(cs, r.started)
  else if (cf && r.started && !r.finished) d = daysBetween(cf, r.started)
  return d !== null && d <= PAIR_WINDOW_DAYS ? d : null
}

/**
 * Fold one book's StoryGraph reads into its BookWyrm cycles.
 *
 * Each read is paired with at most one cycle, closest first. A paired cycle keeps every
 * date it has; StoryGraph fills a missing start or finish, and a date both sides have
 * that differs is a conflict BookWyrm wins. A start StoryGraph would put after the
 * cycle's own finish is refused the same way rather than producing a read that ends
 * before it begins. An unpaired read becomes a cycle of its own, so a reread stays a
 * reread. Cycles are then re-ordered and re-numbered, and the book's window re-derived
 * with the same reducers `collapseReadingEvents` uses.
 */
export function mergeStorygraphReads(book: CollapsedBook, reads: StorygraphReadRange[]): MergeOutcome {
  const outcome: MergeOutcome = { book, startsFilled: 0, finishesFilled: 0, readsAdded: 0, conflicts: [] }
  if (reads.length === 0) return outcome

  const cycles: ReadingCycle[] = book.cycles.map((c) => ({ ...c }))

  const candidates: { ci: number; ri: number; d: number }[] = []
  cycles.forEach((c, ci) =>
    reads.forEach((r, ri) => {
      const d = distance(c, r)
      if (d !== null) candidates.push({ ci, ri, d })
    }),
  )
  candidates.sort((a, b) => a.d - b.d || a.ci - b.ci || a.ri - b.ri)

  const usedCycles = new Set<number>()
  const usedReads = new Set<number>()
  for (const { ci, ri } of candidates) {
    if (usedCycles.has(ci) || usedReads.has(ri)) continue
    usedCycles.add(ci)
    usedReads.add(ri)
    const c = cycles[ci]
    const r = reads[ri]

    const cf = day(c.finished)
    if (cf && r.finished && cf !== r.finished) {
      outcome.conflicts.push({ book: book.title, field: 'finished', bookwyrm: cf, storygraph: r.finished, reason: 'disagree' })
    } else if (!c.finished && r.finished && !c.abandoned) {
      // A cycle he put down stays put down: StoryGraph may count the same pass as read,
      // but BookWyrm saying "stopped" is a date it has, and it wins.
      c.finished = fromDay(r.finished)
      c.finishedSource = 'storygraph'
      outcome.finishesFilled++
    }

    const cs = day(c.started)
    const end = day(c.finished ?? c.abandoned)
    if (cs && r.started && cs !== r.started) {
      outcome.conflicts.push({ book: book.title, field: 'started', bookwyrm: cs, storygraph: r.started, reason: 'disagree' })
    } else if (!cs && r.started) {
      if (end && r.started > end) {
        outcome.conflicts.push({ book: book.title, field: 'started', bookwyrm: end, storygraph: r.started, reason: 'start_after_finish' })
      } else {
        c.started = fromDay(r.started)
        c.startedSource = 'storygraph'
        outcome.startsFilled++
      }
    }
  }

  reads.forEach((r, ri) => {
    if (usedReads.has(ri)) return
    cycles.push({
      started: r.started ? fromDay(r.started) : null,
      finished: r.finished ? fromDay(r.finished) : null,
      abandoned: null,
      cycle: 0,
      ...(r.started ? { startedSource: 'storygraph' as const } : {}),
      ...(r.finished ? { finishedSource: 'storygraph' as const } : {}),
    })
    outcome.readsAdded++
  })

  const at = (c: ReadingCycle): number =>
    (c.started ?? c.finished ?? c.abandoned)?.getTime() ?? Number.POSITIVE_INFINITY
  cycles.sort((a, b) => at(a) - at(b))
  cycles.forEach((c, i) => (c.cycle = i + 1))

  const firstStart = cycles.find((c) => c.started)
  const lastFinish = [...cycles].reverse().find((c) => c.finished)
  outcome.book = {
    ...book,
    cycles,
    started: firstStart?.started ?? null,
    finished: lastFinish?.finished ?? null,
    // `shelf` is untouched: it is BookWyrm's current state, not a date.
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Matching a StoryGraph row to a BookWyrm book
// ---------------------------------------------------------------------------

/** A book the actor has on BookWyrm, with whatever identity the archive holds for it. */
export interface MatchCandidate {
  /** The collapse key: `normalizeTitle(title) || url`, as `collapseReadingEvents` keys it. */
  key: string
  url: string | null
  title: string | null
  /** Every author name known for it (status, then Edition metadata). */
  authors: string[]
  /** Every ISBN-13 known for any of its Editions. */
  isbn13s: string[]
}

export interface BookMatch {
  key: string
  url: string | null
  by: 'isbn' | 'title_author'
}

/**
 * Fold a title for comparison: diacritics off, lower case, punctuation to spaces. The
 * subtitle (after a colon) is dropped by `titleForms`, not here, so both forms compare.
 */
export function normalizeMatchText(s: string | null): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The full title and the title before its subtitle. StoryGraph and BookWyrm disagree on which to show. */
function titleForms(title: string | null): string[] {
  const full = normalizeMatchText(title)
  const base = normalizeMatchText((title ?? '').split(':')[0])
  return [...new Set([full, base].filter(Boolean))]
}

/** A name compared whole, and by surname: "Ursula K. Le Guin" vs "Ursula Le Guin". */
function authorsMatch(a: string[], b: string[]): boolean {
  const names = (xs: string[]) => xs.map(normalizeMatchText).filter(Boolean)
  const surname = (n: string) => n.split(' ').pop() ?? n
  const left = names(a)
  const right = names(b)
  return left.some((l) => right.some((r) => l === r || surname(l) === surname(r)))
}

/**
 * The BookWyrm book a StoryGraph row is, or null. ISBN-13 first, then normalised title
 * with an agreeing author. A title that matches more than one book is no match at all:
 * attaching a read to the wrong volume of a series is worse than leaving it unmatched,
 * where the report shows it.
 */
export function matchStorygraphBook(
  row: { title: string; authors: string[]; isbn13: string | null },
  candidates: MatchCandidate[],
): BookMatch | null {
  if (row.isbn13) {
    const hits = candidates.filter((c) => c.isbn13s.includes(row.isbn13!))
    if (hits.length === 1) return { key: hits[0].key, url: hits[0].url, by: 'isbn' }
  }
  const forms = titleForms(row.title)
  const full = forms[0]
  const byTitle = (exact: boolean) =>
    candidates.filter((c) => {
      const theirs = titleForms(c.title)
      const titleHit = exact ? theirs[0] === full : theirs.some((t) => forms.includes(t))
      return titleHit && authorsMatch(row.authors, c.authors)
    })
  // An exact full-title hit beats a subtitle-stripped one, so "Dune" and "Dune: Messiah"
  // do not collide when both are on the shelf.
  const exact = byTitle(true)
  if (exact.length === 1) return { key: exact[0].key, url: exact[0].url, by: 'title_author' }
  if (exact.length > 1) return null
  const loose = byTitle(false)
  if (loose.length === 1) return { key: loose[0].key, url: loose[0].url, by: 'title_author' }
  return null
}

/** The provenance of the book window's two ends, from the cycles that supplied them. */
export function bookWindowSources(book: CollapsedBook): {
  started: 'bookwyrm' | 'storygraph' | null
  finished: 'bookwyrm' | 'storygraph' | null
} {
  const s = book.cycles.find((c) => c.started)
  const f = [...book.cycles].reverse().find((c) => c.finished)
  return {
    started: book.started ? (s?.startedSource ?? 'bookwyrm') : null,
    finished: book.finished ? (f?.finishedSource ?? 'bookwyrm') : null,
  }
}

/** The key a collapsed book is matched on, computed the same way at import and at load. */
export function collapseKey(book: { title: string | null; url: string | null }): string | null {
  return normalizeTitle(book.title) || book.url || null
}
