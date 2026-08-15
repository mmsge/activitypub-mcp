# 0041 — Ask the archive what it holds, not whether a name answers: walk the unfiltered query

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (ran `--no-domain` on the box, which turned a one-line curiosity into a 59-page route worth walking) + Claude (agent decisions: read `snapshotDomain` as distinct from the requested domain, added the paged walk and the per-domain tally, and made a walk-sourced target page outrank the named one in the verdict)
- **Affects:** `src/lib/linkedin-probe.ts`, `scripts/probe-linkedin-snapshot.ts`
- **Topics:** linkedin, ingest, diagnostics, observability

Extends [0039](0039-a-clean-run-that-explains-nothing-is-not-observability.md) and
[0040](0040-the-wait-was-over-and-the-state-still-said-wait.md).

## Context

ADR 0040 established that `MEMBER_SHARE_INFO` is missing from a *completed* archive:
every peer activity domain has collated, and asking for that one by name returns
`404 No data found for this domain and memberId.`

The docs note, almost in passing, that `domain` is optional and that omitting it returns
"data from all domains". Run on the box, that unfiltered query answers **200 with
`paging.total: 59`**, its first page carrying `LOGIN` records.

That makes two questions distinct, where the probe had been treating them as one:

- *does asking for this domain by name work?* — no, demonstrably;
- *does the archive contain this domain's data at all?* — **unknown**, and only the
  unfiltered walk can answer it.

If a `MEMBER_SHARE_INFO` page turns up in those 59, the data exists and is reachable and
only the per-domain lookup is broken. That is a workaround, and it is also a much sharper
thing to put in a support ticket than "one domain 404s".

## Decision

Read `elements[0].snapshotDomain` — what LinkedIn says it *answered with* — as a field
distinct from the domain that was *asked for*, and add `--pages N` so the unfiltered query
can be walked. The run then prints a per-domain tally of records and states plainly
whether `MEMBER_SHARE_INFO` appeared.

Three details are load-bearing:

- **A walk-sourced target page outranks the named one in the verdict.** If the walk yields
  `MEMBER_SHARE_INFO` records while the named lookup 404s, the verdict is
  `WORKAROUND FOUND`, not `data` — because the interesting fact is not that data arrived
  but that it arrived by the route nobody was using.
- **`paging.total` is printed as a hint and never used as a terminator.** ADR 0033 is
  emphatic that it under-reports, and that rule is unchanged; a progress line may be
  wrong, a loop condition may not. The walk stops on the no-data terminator or on
  `--pages`, whichever comes first.
- **Auth still outranks everything.** A refused token explains every 404 beneath it,
  including one from a walk page, so that ordering is asserted by a test.

## Consequences

- The next command to run is `--no-domain --pages 60`, and it has exactly two outcomes,
  both useful: the target appears (workaround, and the poller could be taught to crawl
  unfiltered), or it does not (the data genuinely is not in the archive, which is what the
  DMA ticket should say).
- Long walks would otherwise drown the raw-response dump, so empty pages are omitted from
  it past a dozen probes unless `--full` is given; the tally above it is the summary.
- `--pages` is capped at 500. Generous against a 59-page archive, present so a typo cannot
  turn a diagnostic into an afternoon of requests.
- The poller is deliberately **not** changed to crawl unfiltered. That would be a real
  redesign — 59 pages of every domain, weekly, to extract one — and it should not be
  built on a hypothesis. If the walk finds the data, that is the moment to consider it.
