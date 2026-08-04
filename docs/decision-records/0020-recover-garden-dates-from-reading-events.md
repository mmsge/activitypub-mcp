# 0020 — Recover garden note dates from reading events, and list what stays undated

- **Status:** Accepted
- **Date:** 2026-08-04
- **Contributors:** Markus (asked & decided: recover what can be recovered from BookWyrm, and list the rest dateless rather than hide them or invent dates) + Claude (established that markus.plus has no dates to backfill, proposed the BookWyrm derivation, implemented the derivation and the list)
- **Affects:** `drizzle/0022_garden_note_derived_dates.sql`, `src/jobs/derive-garden-dates.ts`, `src/stream/garden-date-sql.ts`, `src/stream/lanes.ts`, `src/stream/query.ts`, `src/lib/fetch-garden.ts`
- **Topics:** stream, garden, dates, provenance, privacy, postgres

## Context

ADR 0018 orders the public stream by when things happened, and an entry with no
derivable date is excluded — that is what keeps `(event_at DESC, ref_id DESC)` a
strict total order and the keyset pagination correct.

For the markus.plus garden that excluded most of it. Of the 384 published notes,
**102 carry a `dato`/`modified`/`anskaffet` frontmatter field and 282 do not.** The
obvious fix — "backfill the dates from markus.plus" — turns out not to exist. The
Obsidian Publish cache document was checked field by field: the 282 undated notes
carry `permalink`, `description`, `image`, `fediverse:creator`, and for the book
reviews `forfattar`/`bookwyrm`/`isbn`/`språk`/`serie` — and no date of any kind. The
cache entries themselves carry `headings`, `links`, `tags`, `frontmatterPos` and no
mtime or ctime. There is no date to backfill.

The obvious substitute, `garden_notes.fetched_at`, is a fiction: it would date a
2019 travel note to whenever the crawler first happened to see it, and nothing
downstream would ever reveal that.

## Decision

**Recover the dates that are recoverable, and list the rest without one.**

**158 of the 282 undated notes carry a `bookwyrm` frontmatter field** — the BookWyrm
Edition URL of the book being reviewed. That is already this codebase's join key
(`book_metadata.book_url`, used by `sync-book-metadata.ts` to enrich editions from
Markus' hand-written reviews), and the archive already holds his own dated reading
events for those editions. `jobs/derive-garden-dates.ts` walks that join: for each
edition, the best-dated **public** reading event, preferring a *review* over a
*finish* and the reader's own `finish_date` over the post's `published_at`.

That date is *recovered*, not invented — it is when he finished and reviewed the
book he then wrote about — and three rules keep it honest:

- **It never touches `note_date`.** `derived_date` is a separate column. What the
  note says about itself and what we worked out stay separable, and the entry says
  which it is showing: *"Notatet har ingen eigen dato — denne er henta frå lesinga
  av boka."* Merging them would make the provenance unrecoverable after one sync.
- **Only public reading events count.** A followers-only review's date would
  otherwise become a public fact about when Markus read something. Same fail-closed
  rule as ADR 0017, reusing the same `publicOnlyOn` predicate.
- **`gardenEventAtOn` is the single definition** of when a note happened, shared by
  the lane, the derivation's counters and the dateless list. Three copies of
  `coalesce(own, derived)` would eventually disagree, and the visible symptom would
  be the page calling a note undated while showing it in the stream.

**The remaining ~124 notes are listed, not hidden.** They appear by name and link at
the foot of `/kjelde/hage` under *"Utan dato"*, outside the stream. Dropping them
from the site entirely would hide a third of the garden; giving them a made-up date
would put a falsehood in an archive whose whole ordering premise is that the dates
are real.

## Consequences

- Roughly 56% of the previously invisible garden enters the stream, dated by the
  reading it is about. The rest is reachable but unplaced.
- A book review's note now sits near its BookWyrm review in the timeline, sometimes
  adjacent to it. That is two entries about one book — accepted for the same reason
  the BookWyrm/NeoDB overlap was: they are different writing, and the alternative is
  suppressing one of them by guesswork.
- The derivation is idempotent (`IS DISTINCT FROM` guards the UPDATE; a second run
  reports `updated: 0`) and runs at the end of every garden sync, so a note that
  arrives or gains a `bookwyrm` field is dated in the same pass.
- `still_undated` is logged on every sync. If it starts climbing, notes are being
  published that neither date themselves nor review a book — worth knowing, and
  invisible otherwise.
- The date of a re-read would move a note. Ranking review-before-finish and taking
  the newest within a rank means a book read twice dates the note to the second
  reading. Not worth a column to fix; the note is about the book, not the sitting.
- Verified by execution against Postgres 16 with all 23 migrations, not by SQL-shape
  assertions — PR #66 is why. The fixtures cover a public review, a followers-only
  review, a finish with no review, a future-dated review, a rating-only book, a note
  with both dates, and an unparseable `note_date`.
