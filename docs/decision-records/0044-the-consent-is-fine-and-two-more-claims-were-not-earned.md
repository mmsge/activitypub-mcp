# 0044 — The consent is fine: the diagnosis holds, and two more unearned claims are retired

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (ran the probe that closed the last open alternative and, in doing so, produced the output that exposed both over-claims) + Claude (agent decisions: gated the archive-absent verdict on controls actually having been probed, and paged the changelog instead of sampling it)
- **Affects:** `src/lib/linkedin-probe.ts`, `src/lib/fetch-linkedin-snapshot.ts`, `scripts/probe-linkedin-snapshot.ts`
- **Topics:** linkedin, ingest, diagnostics, observability

Closes the investigation opened in [0039](0039-a-clean-run-that-explains-nothing-is-not-observability.md)
and continued through 0040–0043.

## Context

ADR 0043 added the `memberAuthorizations` check because it was the one call that reports
on the **consent itself** rather than on a product of it, and therefore the last standing
alternative to ADR 0042's diagnosis. It ran:

```
Consent:   registered 2026-08-10T07:29:27.592Z  scopes: DMA  app: urn:li:developerApplication:250340651
Changelog: 10 event(s), 0 post create(s)  2026-08-10 → 2026-08-11
           socialActions/likes×6, messages×2, invitations×2
MEMBER_SHARE_INFO  404  · none
```

**The consent is registered, correctly, with the `DMA` scope, bound to a real developer
application, at 07:29 on 10 August.** That closes the last alternative. The chain is now
complete and every link is observed rather than assumed:

- the token is accepted (`PROFILE` and 41 other domains answer);
- the consent is registered, scoped and timestamped;
- collation finished (`ALL_LIKES`, `ALL_COMMENTS`, `INSTANT_REPOSTS` all filled in);
- the archive is comprehensive (42 domains with records);
- `MEMBER_SHARE_INFO` is absent from it, by name and unfiltered alike.

**ADR 0042's verdict stands, and there is nothing left to rule out.** The remaining action
is the DMA support form.

But the same run made two statements it had not earned.

### "controls included", with no control probed

The run was `--domain MEMBER_SHARE_INFO`. One domain. The verdict printed:

> no domain returned anything, **controls included**, and nothing was refused. The archive
> does not exist rather than being late

Every clause after the comma is unsupported. No control was asked; nothing could have been
refused that was not asked. The sentence happened to reach a conclusion that other runs
had established, which is worse than being wrong, because it would read as confirmation.

### "0 post create(s)", from ten events

The changelog was read with a single `count=10` request. The line reported `0 post
create(s)` across a window rendered as `2026-08-10 → 2026-08-11`, which reads as a survey
of the 28-day window. It was the **ten oldest events in it**. "No posts in the changelog"
and "no posts in the first ten events" are different claims and only the second was
observed.

## Decision

**The archive-absent verdict is gated on controls having been probed.** With none in the
run, it returns `inconclusive` and names the command that would settle it. The count of
controls that did answer is quoted in the verdict, so the claim carries its own evidence.

**The changelog is paged, not sampled.** `changelogUrl(startTime, count)` with `count=50`
(the API's maximum), following the documented `processedAt` cursor for up to 20 pages —
1000 events across a 28-day window. `mergeChangelog` folds the pages; `truncated` marks a
read that stopped at the cap, so a partial read can never be quoted as a survey. A page
whose cursor does not advance is the end, because the docs say the boundary event repeats
on the next request and a repeat is not a loop to keep chasing.

## Consequences

- **The LinkedIn side is closed as far as this repo can take it.** Everything downstream
  of the fetch is built, tested and correct; the data does not exist. The ticket can now
  state the full chain, with an `x-li-uuid` per request and the consent's own
  `regulatedAt` and application URN.
- **What the changelog holds is still open**, and the paged read is what will say. The
  ten events seen were likes, messages and invitations — no posts — but Markus may simply
  not have posted since 10 August, in which case zero post creates is correct behaviour
  and says nothing about whether the route would carry one. That is a question for the
  next run, not an answer from this one.
- **Five ADRs, one failure mode.** 0039: a state that could not come out false. 0040: a
  check that could not bear on the claim it was read as supporting. 0042: an answer buried
  under its own evidence. 0043: an endpoint never called. 0044: two sentences asserting
  more than the run observed. Every one was found by running the thing and reading the
  output rather than by reasoning about it — including the two here, which were in the
  diagnostic *built to prevent exactly this*, and which said something agreeable enough
  that only the mismatch with the command line gave them away.
