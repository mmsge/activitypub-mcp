# 0054 — A second consumer splits the transport from the policy

**Status:** Accepted
**Date:** 2026-08-20
**Topics:** webhooks, notifications, integration, configuration, msge-no, debounce

**Contributors:** Markus (asked & decided: give msge.no the same webhook behaviour bartenderen has, and wire both sides rather than shipping the endpoint alone) + Claude (agent decision on the transport extraction, the topic vocabulary, the debounce ceiling, and on not notifying scrobbles)

**Affects:** `src/lib/webhook-post.ts`, `src/lib/msge-webhook.ts`, `src/lib/trip-webhook.ts`, `src/config.ts`, `src/admin/router.tsx`, `src/activitypub/handlers/create.ts`, `src/jobs/sync-garden-content.ts`

## Context

ADR 0053 wired this service's first outbound webhook: the train-trip import wakes
`bartenderen`, which tends the "Neste togtur" profile field. Its last bullet
predicted what a second consumer would want, and closed with *"One consumer is not a
pattern."*

msge.no is now that second consumer. Sixteen pollers there read this API on fixed
intervals — the slow ones every six hours — and cache the result as the `/data/*.json`
its pages serve. Because the sync jobs on **this** side are periodic too, the wait
from "Markus uploads a Viaduct CSV" to "the site shows it" was the sum of both sides:
up to about twelve hours for trains, books and the YouTube archive.

So the prediction can be checked against a real case rather than argued about.

## Decision

**0053 was right about the policy and wrong about the transport.**

Right about the policy: msge.no genuinely does want its own module, its own config
pair and its own calls. The two receivers differ in every way that matters — one
takes a pure ping and encodes meaning in its path, the other takes a topic; one has a
single trigger, the other four; the header names differ; msge.no's receiver refuses
anything that arrived through Caddy. A generalised fan-out would have to paper over
all of it. There still is no registry and no fan-out.

Wrong about the transport. The thirty lines those two calls share are exactly the
lines where a mistake is expensive and invisible — never throw, never retry, log
loudly, and log the error *message* rather than the object because pino serialises
`cause` and `cause` carries the address dialled. Copy-pasting those is how the second
copy quietly loses one.

**So the transport was extracted and nothing else was.** `src/lib/webhook-post.ts`
holds `postWebhook({url, headerName, secret, body?, label})`. `trip-webhook.ts` and
`msge-webhook.ts` are thin named wrappers over it, each keeping its own config pair,
header, vocabulary and log line. The `label` is what keeps the failure messages
distinct, so "which webhook failed" stays answerable from the message alone.

**The acceptance criterion was that `src/lib/trip-webhook.test.ts` pass completely
unmodified**, which it does — all eight cases, including the `TRIP WEBHOOK FAILED`
string assertions. If any assertion there had needed to move, the extraction had
changed behaviour and should have been reverted.

Four more decisions inside this:

**1. A topic names the upstream event, not the page.** `tog`, `tuben`, `bok`, `film`,
`tut`, `bilete`, `tankehav`, `lyttar`, `poppis`. Which pollers each wakes is declared
in msge.no's own `POLLERS` registry, so it can add a page without a change here. The
URL is a base plus the topic, and it must be the bridge address: msge.no's receiver
refuses anything carrying `X-Forwarded-*`, so `https://msge.no` answers 404 by design.

**2. The ingest path is debounced, and the debounce has a ceiling.** The two admin
imports are single events and notify directly. `ingestObject` is not — it fires once
per object, and a NeoDB repair or an outbox re-crawl pushes hundreds through in
seconds. The burst is collapsed here, where it happens, rather than in msge.no's rate
limiter, which would otherwise sit saturated for everything else that arrived during
the backfill. Trailing rather than leading, because the last object of a batch is the
one that makes the batch worth refreshing for.

**`MAX_DELAY_MS` is not optional.** A trailing debounce with no ceiling is pushed out
by every new object, so a thirty-minute backfill would send *nothing at all* — the
failure mode being a feature that looks like it works right up until the one case it
exists for. The timer is `unref()`d for a smaller version of the same problem: without
it a pending debounce holds a short-lived script, and vitest, open for ten seconds.

**3. A NeoDB book mark is `bok`, not `film`.** msge.no's `/film` and `/plakaten` are
built from `/watched`, which is film and TV. A book mark routed there wakes a poller
that will never show it and leaves `/bokhylla` waiting out its own six hours.
`isNeodbBookUrl` is already imported in `create.ts` to route enrichment, so the check
costs nothing.

**4. Scrobbles are deliberately not notified.** `LASTFM_SYNC_INTERVAL_SECONDS`
defaults to 60 and msge.no's `fetchScrobbles` runs every 60, so the expected saving
is under thirty seconds. The cost is a POST every minute, all day, forever, plus a
permanently occupied rate-limit slot on the receiver so nothing else in that topic
can get through. 0053's value was collapsing a four-hour worst case; here the worst
case is one minute. **This is a decision, not an oversight** — recorded so it is not
"fixed" within a year.

## Consequences

- Worst-case staleness on msge.no for a trip or YouTube import drops from ~12 h to
  seconds; the garden section from ~12 h to the length of one sync.
- One more secret duplicated across two `.env` files with nothing enforcing the
  match, exactly as 0053 records for bartenderen. A drift answers 401 and
  `MSGE WEBHOOK FAILED` names the status — which is why that line exists.
  `.env.example` carries an `awk` recipe that compares lengths without printing
  either secret.
- `notifyMsgeChanged` and `notifyMsgeDebounced` both take an injectable target, like
  `notifyTripsChanged`, so the debounce is testable without touching config.
- Gig attendances map to `tut` rather than a `konsert` topic, because msge.no has no
  gig page yet and a topic nothing listens to is a wake that always 400s. The comment
  in `msgeTopicFor` names where to add one.
- The garden sync now notifies only when a pass actually moved something — a cycle
  where every note answered 304 has re-stated what msge.no already has.
- **A third consumer is now the interesting case.** Two consumers sharing a transport
  is not a bus; if a third arrives wanting the same topics as msge.no, that is the
  point to reconsider a real fan-out — and not before.
