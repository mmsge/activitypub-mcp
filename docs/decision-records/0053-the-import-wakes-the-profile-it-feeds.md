# 0053 — The import wakes the profile it feeds, and only when something changed

**Status:** Accepted (final bullet amended by 0054)
**Date:** 2026-08-18
**Topics:** trains, import, webhooks, notifications, configuration, integration

**Contributors:** Markus (asked & decided: wire the webhook — "bring in the activitypub-mcp repo for point 2") + Claude (agent decision on the fire-on-change rule, the no-retry rule, and the never-throw contract)

**Affects:** `src/lib/trip-webhook.ts`, `src/admin/router.tsx`, `src/config.ts`

## Context

`bartenderen` (`mmsge/bartenderen`, `/srv/bartenderen`) tends the `Neste togtur`
field on `@markus@skvip.lol` from the train-trip archive this service owns. It is
the first consumer of that data that has to react *promptly* rather than answer a
query.

Its scheduler has no fixed interval: it computes when the field could next change
— the next departure, the current arrival, local midnight — and sleeps until then.
That is exact for every leg already stored, and blind to the one case that matters
most. **Nothing in the existing data predicts a leg that does not exist yet**, and
legs are typically entered *because* a journey is imminent, often while it is
already under way.

Its own backstop is a four-hour cap on any sleep, after which it re-reads
regardless. That is the correct floor, and it is a poor mechanism: it means the
profile can advertise the wrong train for up to four hours after Markus has told
the system about the right one, which is precisely the manual upkeep the service
exists to remove.

The CSV upload at `POST /admin/import/trips` is the **only** way new legs enter.
`resolve-trip-lines`, `link-trip-posts` and `sync-stations` all post-process rows
that are already there. So there is exactly one place to say "this changed".

## Decision

After `importTrainTrips()`, POST to `BARTENDEREN_WEBHOOK_URL` with the shared
secret in `X-Bartenderen-Token`. Three rules, each of which rules something out:

**Only when `inserted + updated > 0`.** Re-uploading an export is the common case
and usually changes nothing. Waking a service to recompute an identical answer is
noise: it would read the same legs, render the same string, diff it against the
live profile and write nothing. The check belongs on this side because this side
is the one that knows.

**Never throw.** A failed notification must not fail the import. The import is the
durable thing; the notification only changes how quickly someone else notices.

**Never retry.** The receiver's four-hour cap already re-reads the source, so a
dropped notification costs latency and nothing else. A retry loop here would be a
second, worse implementation of a timer that already exists on the other side.

Failures are logged **loudly** — `TRIP WEBHOOK FAILED` with the status — following
`publishNtfy`. hetzner-server ADR 0011 records weeks of silently-401ing ntfy pushes
hidden behind `curl -sf … || true`; the two statuses that matter here are 403 (the
secret has drifted from `bartenderen`'s `WEBHOOK_SECRET`) and 503 (`bartenderen`
has none set, so its own webhook is off). Both are configuration, and both stay
invisible forever without that line.

An empty `BARTENDEREN_WEBHOOK_SECRET` makes every notification a logged no-op, so
the feature is inert until the secret is in `/srv/bot/.env` — the `NTFY_PASSWORD`
shape, for the same reason.

## Consequences

- A leg entered mid-journey reaches the profile in about a second instead of up to
  four hours. The cap becomes what it was designed to be: a backstop.
- The two services stay loosely coupled. This one needs no knowledge of what
  `bartenderen` does with the signal, sends no payload, and is unaffected if it is
  down — the receiver re-reads on its own schedule either way.
- **The secret is duplicated in two `.env` files and nothing enforces that they
  match.** A drift is silent apart from the 403 line, which is why that line is
  loud and why a test pins it.
- The error *message* is logged rather than the error object: pino serialises
  `cause`, which on a connection failure carries the address dialled, and an IP in
  a log line is on the box's never-log list. `fetch failed` and the timeout's abort
  reason name no host.
- A second consumer would want its own config pair and its own call here, not a
  generalised fan-out. One consumer is not a pattern.
  **Amended by 0054.** msge.no became that second consumer and this held for the
  domain logic — it does have its own module, config pair and call, and there is
  still no fan-out. What it did not anticipate is that the never-throw / never-retry
  / log-loudly rules above are *transport*, not policy, and a second copy of them is
  a second chance to lose one. They moved to `src/lib/webhook-post.ts`; nothing else
  was shared.
