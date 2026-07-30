# 0012 — Store the mark's shelf date as its own column, and let `get_watched` filter and sort on it

**Status:** Accepted
**Date:** 2026-07-30
**Topics:** neodb, activitypub, marks, watched, dates, backdating, backfill, filtering, sorting, watch-history
**Contributors:** Claude (agent decision — no human input on the technical design; the task fixed the acceptance criteria, not the implementation)

## Context

ADR 0011 got the 27 backdated film marks ingested: title, year, IMDb id, director,
cover, description and the comment ("Sett på kino.") all reached `get_watched`. The one
thing that did not was the date the films were seen.

The whole point of the minreol backfill is watch dates. The films are decades old; the
interesting fact is that Anomalisa was seen on 9 February 2016, not that it exists. Live
after the #59 deploy, `get_catalogue_details` for Anomalisa returned every enriched field
and **no date of any kind**, while `get_actor_posts` returned
`published_at: 2026-07-30T19:04:58.824Z` — the moment the mark was created. minreol's own
page said "Feb. 9, 2016 watched · Sett på kino." The data arrived and was dropped.

It was dropped because it is not where it looks like it should be. The shelf date is not
on the `Note`; it is on the `relatedWith` entry whose `type` is `Status`:

```json
"relatedWith": [
  {"type": "Status", "status": "complete",
   "published": "2016-02-09T12:00:00+00:00",
   "updated": "2026-07-30T19:05:47.505415+00:00",
   "withRegardTo": "https://minreol.dk/movie/6qIY8Uiq2b59Qq3uMDQ1AF"},
  {"type": "Comment", "content": "Sett på kino.",
   "published": "2026-07-30T19:04:58.824403+00:00",
   "withRegardTo": "https://minreol.dk/movie/6qIY8Uiq2b59Qq3uMDQ1AF"}
]
```

Both plausible-looking neighbours are wrong. The `Note`'s own `published` is the post
timestamp, and the `Comment` entry's `published` tracks the comment — both say "today" for
a mark backdated to 2016. `Status.updated` is a third distinct thing: when the mark was
last edited.

## Decision

**`neodb_marks.watched_at`, read strictly from `Status.published`, with no fallback.**
A backdated mark is created today (`published_at`), last edited today (`updated_at_ap`)
and watched in 2016 (`watched_at`) — three columns because they are three facts. Where the
Status carries no `published`, the column stays null; falling back to the `Note` would
report "watched today" for every backdated mark, which is exactly the failure being fixed.

- **Named `watched_at`, not `marked_at`.** Books, music and games carry the same `Status`
  entry and use the same column and code path — the name follows `get_watched`, which has
  covered every category since ADR 0006. `marked_at` was the alternative the task offered;
  it was rejected because it reads as "when the mark was made", which is precisely the
  other column (`published_at`) that this one has to be told apart from.
- **The `Note`'s `published_at` does not change.** It is correct as the post timestamp and
  `get_actor_posts` keeps reporting it. This is a different field with a different meaning.
- **Plural on the read side, following `mark_titles` / `mark_comments`.** An item can be
  marked more than once — re-watched years later, or marked by a second actor — so
  `watched_dates` is every distinct date across the item's live marks, newest first, with
  tombstoned marks excluded, `[]` when none. Scalar `watched_at` is the newest of them,
  null when unknown; it is what a reader wants and what sorting needs, since an array
  cannot be a sort key.
- **Read live off `neodb_marks`, not materialised** onto the catalogue row — same reasoning
  as `mark_comments` in ADR 0011: the date only ever comes from the mark, so there is
  nothing for it to go stale against.
- **Filtering is per-mark, not against the item's latest date.** `watched_from` /
  `watched_to` (plus `watched_year` sugar) match an item if **any** of its live marks falls
  in the window, so a film seen in 2016 and again in 2020 answers both years.
- **`sort_by` is new; `sort_order` is unchanged.** `sort_by: 'fetched_at'` stays the
  default, so no existing caller moves. `sort_by: 'watched_at'` orders by the shelf date in
  either direction, with undated items last both ways. The old ordering is enrichment time,
  which for a bulk import is only the order the import ran in — meaningless as history.

## The `Update` that carries the real date

A mark's shelf date routinely arrives **after** the mark. This is not an edge case; it is
the backfill's working procedure, because minreol does not federate a backdated mark on
creation:

- `Create` at 19:04:58 — the mark exists, `Status.published` is today.
- `Update` at 19:05:47 — same `Note` id, `Status.published` is 2016-02-09.

So the date has to be **updated**, not merely captured on create. It rides the existing
`updated`-stamp guard in `upsertNeodbMark`: the `Update` carries a strictly newer
`Status.updated`, so it qualifies to overwrite. One clause was added for the degenerate
case where the two stamps tie — a row still missing a date accepts one that is offered.
That arm is monotone (it only ever fills a null), so it cannot revert a corrected date to
an older delivery's. Verified end-to-end against Postgres, including that a redelivery of
the original `Create` does **not** undo the correction.

## Why the backfill needs its own pass, again

Same trap ADR 0011 hit with `comment`, and it is worth restating because it will recur
with the next column: `upsertNeodbMark` overwrites only on a strictly-newer `updated`
stamp, so replaying stored marks — the obvious way to populate a new column — is a
deliberate no-op for every unchanged mark, and the column would stay null forever.

`backfillMarkWatchedDates()` therefore writes the column directly, from each row's own
`raw->'relatedWith'`, which is the `Status` entry exactly as parsed. Reading the row's own
provenance rather than re-walking `objects` also covers marks whose `Note` is no longer
stored. It only ever fills a null, so it is idempotent and cannot clobber a date that
ingest already got right. It runs from `repairNeodbIngest()`, whose marker was bumped to
`neodb_ingest_repair_v2` so existing installs run it once on the next startup.

## Dates that are days, in two shapes

The values are days in every use that matters, but they arrive as instants in two very
different shapes: `T12:00:00+00:00` from our importer, and a local-midnight form like
`22:00:00+00:53` (a mean-solar-time offset) from minreol's own date picker. Both are
stored as the instant, unmodified — normalising them would be inventing precision we were
not given.

Day-boundary semantics are therefore **stated rather than inferred**. A bare `YYYY-MM-DD`
bound is anchored to UTC: `watched_from` to that day's start, and `watched_to` to the
**following** midnight, exclusive — otherwise `watched_to=2016-12-31` would silently drop
everything actually watched on 31 December, which is the kind of off-by-one that looks like
missing data rather than a bad query. A full ISO timestamp is taken at face value and
compared inclusively. The response echoes back the window it resolved to
(`filters.watched_window`), so a caller can see which reading applied.

Both real shapes land on the intended UTC day. A mark whose instant sits within an hour or
two of midnight in some other zone is the one case where a day-boundary query could
disagree with a human's reading of the date; the semantics are documented rather than
guessed at, and nothing rounds.

## The traps (don't re-derive these)

- **The date is on the `Status`, and only there.** The `Note`'s `published` and the
  `Comment` entry's `published` both track mark creation and both look right in a payload
  you only skim. Reading either produces a store where every backdated film was "watched
  today" — with no error and a correct-looking response.
- **A backslash escape inside a `sql` template literal is eaten by JavaScript.** The
  backfill's date-shape guard was first written `~ '^\d{4}-\d{2}-\d{2}'`; the template
  literal dropped the backslashes and Postgres received a pattern of literal letters, which
  is valid, matches nothing, and made the backfill report "0 filled" — indistinguishable
  from having nothing to do. It is spelled as an explicit character class now, and a test
  asserts the rendered SQL, because nothing else fails when it is wrong. This applies to
  every regex, and to `\n`/`\t`, in every `sql` fragment in this codebase.
- **Drizzle's keyset helpers now take a `sql` expression, not just a `PgColumn`.** The
  shelf-date sort orders on a correlated subquery over `neodb_marks`, since the sort key is
  not a column of the table being paged.
- **The select-list qualification trap from ADR 0011 applies to both new expressions.**
  `markWatchedDatesExpr` and `latestWatchedAtExpr` write `catalog_metadata.item_url`
  table-qualified by hand; an interpolated column would render bare inside the subquery,
  bind to `neodb_marks`' own column, and hand every catalogue row every date in the table.
  Tested on the rendered SQL, like `markCommentsExpr`.
- **"0 rows changed" from a backfill deserves suspicion, not relief.** Both times a column
  was added to this table, the first implementation silently filled nothing — once because
  the upsert guard no-ops, once because of the regex above. Verify against real data.
