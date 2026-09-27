# 0061 — Theatre is a kind of its own

**Status:** Accepted
**Date:** 2026-09-27
**Topics:** neodb, minreol, theatre, performance, marks, enrichment, stream, admin, webhook
**Contributors:** Markus (asked & decided: theatre is logged on minreol and must be understood
fully, its own stream kind worded "såg på teater", a new msge.no topic `teater`, dedicated
tools and stats, both `Performance` and `PerformanceProduction` supported, version 1.2.0) +
Claude (found the URL-as-title trap and the troupe-in-credits gap; proposed the placeholder
retry, the visit as the unit, and the play/production link; implemented)

**Affects:** `src/lib/fetch-neodb-item.ts`, `src/lib/neodb-mark.ts`,
`src/jobs/sync-neodb-metadata.ts`, `src/jobs/sync-neodb-marks.ts`, `src/index.ts`,
`src/mcp/tools/theatre.ts`, `src/mcp/server.ts`, `src/rest/table.ts`, `docs/openapi.yaml`,
`src/admin/media-router.tsx`, `src/admin/media-query.ts`, `src/admin/views/media.tsx`,
`src/admin/views/ui.tsx`, `src/stream/*`, `src/lib/msge-webhook.ts`,
`src/activitypub/handlers/create.ts`

## Context

Markus now logs theatre on minreol. ADR 0006 already enriched every NeoDB category, and the
parser already mapped `Performance` and `PerformanceProduction` to `performance`, so the
first mark (Riksteatret's touring production of Nora Dåsnes' *Ubesvart anrop*, 2026-09-27)
was stored. It was not understood:

- **Its title was a URL.** Markus drafted the item from the Riksteatret page, and NeoDB
  titles a drafted item with its source URL until someone names it. The mark federated
  three seconds after the item was created, enrichment ran at once, and `title`,
  `display_title` and the mark alias all became
  `https://www.riksteatret.no/repertoar/ubesvart-anrop/`. The item was named minutes later
  on NeoDB, but a clean enrichment is fresh for `NEODB_STALE_DAYS` (30), so the URL would
  have stayed for a month. The MinReol MCP's own flow (draft, paste, mark) makes this the
  normal path for theatre, not an accident.
- **The troupe was missing.** NeoDB has no flat `troupe` field on a performance. The
  company exists only in `credits` as `role: "troupe"`. The mapper read the flat arrays, so
  the one thing a touring play is known by was dropped.
- **Everything downstream treated it as a generic mark:** `merka` on the stream, the
  catch-all Other tab in admin, and the `film` webhook topic, whose page is film and TV.

## Decision

**A URL is never a title.** Enrichment takes the first real title from `display_title`,
`title`, a localized title, then `orig_title` (last, because on a production it carries a
"(Troupe)" suffix), skipping anything URL-shaped. When NeoDB still served a URL, the row is
written with the best real title found *and* `fetch_error` set to a placeholder message.
That reuses the existing retry path: a row with an error is never fresh, so the next
periodic pass re-reads it, and it clears itself once NeoDB has a name. No new scheduler.
URL-shaped tag names are refused as mark titles and as catalogue aliases, for every
category, since the trap is not theatre-specific.

**The repair is self-healing, not a script.** The periodic sync treats a stored URL title as
stale however recent, so the startup pass re-reads the one affected row. A one-line update
on every startup clears URL-shaped `neodb_marks.title`; after the first deploy it touches 0
rows, and that is the expected answer.

**The troupe is read out of credits.** Every credit role that has a performance `details`
key (troupe, playwright, director, original creator, composer, choreographer, performer,
actor, crew) is folded in and deduped against the flat array. `cast` keeps the part an actor
played where NeoDB knows it; `official_site` is kept.

**A production links to its play.** `PerformanceProduction` carries `parent_uuid`; it is
stored in the existing `parent_uuid` column and as `details.play_url`.
`get_theatre_details` walks the link both ways.

**The unit is a visit, which is a mark.** `get_theatre`, `get_theatre_details` and
`get_theatre_stats` start from `neodb_marks` and LEFT JOIN the catalogue, because a mark
whose item is not enriched yet is still an evening at the theatre, and an item nobody
marked is not. Wishlist marks are out unless asked for by name, as on the stream. The date
window is on the night. ADR 0060 applies unchanged: a visit on an unknown date is in every
total and in no year. The SQL is raw with hand-qualified aliases, because the two tables
share half their column names (the ADR 0011 trap).

**Its own kind everywhere it is shown.** The stream kind is `theatre` (filter with
`?kind=theatre`), worded "såg på teater", "hadde sett på teater" when undated, with the
troupe and venue leading the facts. The Atom title is `Såg «Ubesvart anrop» (Riksteatret)`.
Admin gets a Media → Theatre tab; performance leaves the Other tab's default view.

**The webhook topic is `teater`,** chosen by path (`/performance/`) on the tag href or on
`withRegardTo`, the one reference every mark carries. This is the one topic sent ahead of
its receiver: msge.no must register it. Until then each theatre mark costs one logged 4xx,
which `postWebhook` never retries and never lets fail the ingest. That was weighed against
the rule that an unregistered topic is a wake that always 400s; at a handful of theatre
visits a year the cost is a log line, and it means msge.no can add a theatre page with no
change here.

## Consequences

- A freshly drafted item shows as "title pending" in admin until the next six-hourly pass,
  under its `orig_title` rather than a URL.
- Venue is only as complete as NeoDB records it. A touring production usually has none, so
  `top_venues` and the `venue` filter describe what is known, not where he was.
- Names are keyed on the name, so two people sharing one count once — the same trade the
  gig stats make.
- Podcasts still fall through to the generic `mark` kind on the stream. Out of scope here.
