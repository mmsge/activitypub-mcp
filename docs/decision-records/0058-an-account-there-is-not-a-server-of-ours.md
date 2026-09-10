# 0058 — An account there is not a server of ours

**Status:** Accepted
**Date:** 2026-09-10
**Topics:** engagement, politeness, watchers, config, incident

**Contributors:** Markus (asked & decided: only sample skvip.lol and the other domains we
own; fix the 401 fallthrough) + Claude (traced the hourly burst to the sampler, found the
401 short-circuit, proposed and implemented the origin gate)

**Affects:** `src/jobs/sample-engagement.ts`, `src/jobs/breakout-fast-lane.ts`,
`src/lib/fetch-engagement.ts`, `src/config.ts`, `.env.example`

## Context

Peter Makholm, who runs `minreol.dk`, asked on Mastodon what the hourly burst of requests
carrying `activitypub-mcp/1.0 (+bot.skvip.lol)` was. The honest answer is that we did not
know, and that finding out took reading our own scheduler.

It was `sampleEngagement`. The job snapshots engagement counts for recent posts so the
trends and the breakout ladder have a time series to read, and it picks its targets from
the **auto-watchlist**: every accepted follow. That was a deliberate and, at the time,
correct simplification — the inbox rejects everyone who is not Markus, so the follows
table is exactly "his accounts across all services", and a new account starts being
tracked without anyone remembering to enrol it.

The simplification hides a distinction that only matters once you are the one sending the
requests. **A follow says he has an account somewhere. It never says the server is his.**
`skvip.lol`, `gigowl.social` and `rullen.no` are ours to poll. `minreol.dk`,
`bookwyrm.social` and `loops.video` are somebody else's machines that he happens to have
an account on, and polling those on a timer is a cost we imposed on a stranger.

Measured on the box the night it was reported: 7 followed actors × the 20 most recent
posts each, every hour. `minreol.dk` answered 401 on all twenty. `bookwyrm.social`,
`rullen.no`, `loops.video` and `gigowl.social` answered 404 on the REST leg and so spent a
second request each on the AP fallback. Roughly 240 outbound requests an hour, for two
useful answers per hour and change.

`skip_unchanged` was not the mitigation it looked like. It suppresses the snapshot **row**,
not the request. Nothing downstream of the fetch can make a poll cheap.

Underneath sat a second bug that had been quietly discarding real data. `fetchRestLeg`
treated a 401 or 403 as terminal — "this post is private, stop" — and never tried the AP
object. But `/api/v1/statuses/:id` is a *Mastodon* route. Software that does not implement
it answers however it answers any unknown path, and NeoDB gates its entire API behind a
token, so it says 401. Every `minreol.dk` post therefore reported no counts at all, while
its AP object had been serving a public `replies.totalItems` the whole time.

The lesson was already written down here, one job over. `THREAD_ACTORS` narrows the same
auto-watchlist to Mastodon "because the context endpoint is a Mastodon API and asking
BookWyrm or Gigowl for one would only manufacture walk errors". The sampler never got the
same treatment, and it is the job that polls hourly.

## Decision

### The list is who we may poll, not who can answer

`ENGAGEMENT_SAMPLE_ORIGINS` is a comma-separated list of hostnames the **unattended** jobs
may dial. It is a politeness gate, not a capability one, and the difference decides the
design: a capability gate could be learned from response codes, but no response code tells
you whether you are entitled to ask. Only Markus knows which hosts are his, so it is
configuration, and it stays configuration.

### Empty means poll nothing, and say so

An unset list falls back to `OWNER_INSTANCE` alone. Unset *and* no owner instance means the
job logs a warning naming what to set and returns without a request. It never means "poll
everything" — defaulting outward is how an unattended job ends up on somebody else's box
in the first place, which is the whole incident.

Following record 0057's rule, the two failures are reported separately because they have
different fixes: nothing configured is a line in `.env`, while configured-but-matched-nothing
prints the excluded hosts and the effective list side by side, so neither needs a psql
session. A successful run logs the excluded hosts too, so the narrowing is visible rather
than merely true.

### The owner instance is always in the set

Whatever is listed, `OWNER_INSTANCE` is folded in. The breakout ladder is built on his own
account; a list that omits it is a typo, and the failure mode of honouring that typo is the
alerts going quiet with everything still apparently configured.

### It binds the timers, never a question

The gate is applied inside `sampleEngagement` and `runBreakoutFastLane`, not inside
`getEngagement`. An explicit `get_engagement` call — from MCP, from the REST API, from the
admin UI — is a person asking about one post, and answering it is one request that a human
is waiting for. What was rude was the timer, not the tool.

### The gate is on the post's host, not the actor's

Both jobs filter the resolved ap_ids, not the actors they were collected under. Filtering
actors is the cheap pass and worth keeping, but the request goes to the **post's** host, and
that is the string the gate has to be applied to for the property to actually hold.

### A REST 401 is not a private post

Only 429 is terminal on the REST leg now. 401 and 403 fall through to the AP object like
404 does. A genuinely private post refuses the AP object too, and `fetchApLeg` returns
`unauthorized` for it — so the terminal answer is still reached, one request later, on the
leg that can tell "you may not read this" from "I have never heard of that route".

## Consequences

- `minreol.dk` drops from ~20 requests an hour to zero from the sampler, and its posts gain
  a working reply count the moment anything does ask about them.
- Breakout coverage narrows to the configured origins. This is the safe direction — it can
  only ever poll less than before — but it is a real narrowing, and a deploy that lands
  before `.env` is updated watches `skvip.lol` alone. The log line names every excluded
  host on every run so the state is visible rather than inferred.
- `skip_unchanged` keeps its job and loses its reputation: it bounds the table, never the
  traffic. The only lever that reduces outbound load is not asking.
- Adding an account on someone else's instance no longer silently enrols their server in an
  hourly poll. It is now a deliberate line in `.env`.

## Rules not to "simplify" back

- **The empty list polls nothing.** Not everything. The whole incident is one job that
  defaulted outward.
- **The owner instance is unconditional.** A list that omits it is a typo, and the cost of
  believing the typo is silence from a feature that looks configured.
- **The gate is on the timers, not on `getEngagement`.** Gating the tool would make an
  ordinary question unanswerable to fix a problem the question never caused.
- **The gate is applied to the post's host.** The actor filter is an optimisation; this is
  the one that holds.
- **`skip_unchanged` is about the table.** An unchanged count is still a request.
