# 0024 — Give the trip↔post join a surface: travel context on posts, and journey pages

- **Status:** Accepted
- **Date:** 2026-08-05
- **Contributors:** Markus (asked whether ADR 0023 had changed anything on a website, and chose both the small surface and the full one) + Claude (established that it had not, proposed the two surfaces, implemented them)
- **Affects:** `src/stream/journeys.ts`, `src/stream/views/journey.tsx`, `src/stream/query.ts`, `src/stream/entries.ts`, `src/stream/router.tsx`, `src/stream/views/entry.tsx`, `src/stream/views/layout.tsx`, `src/stream/lanes.ts`, `src/rest/table.ts`
- **Topics:** stream, trains, posts, joins, journeys, rest, postgres

## Context

ADR 0023 derived which train each post was written on, and the backfill bound
**415 posts across 119 of the 229 trips**. None of it was visible anywhere. The
only consumer was the MCP tool, so the data was reachable from an AI client and
from nothing else — not meg.msge.no, not the admin UI, not the REST API, and
therefore not msge.no either, which builds its `/togselfie` gallery from the
bot's REST endpoints and had no way to ask.

That is the gap this record closes. It also settles a question ADR 0023 left
open by implication: it said any public surface "must apply `publicOnlyOn`
itself", which quietly assumed a surface would arrive later.

## Decision

**Three surfaces, and one derivation that makes the second one possible.**

### The public name of a journey is derived, not mapped

A journey has two names. `train_trips.journey` is the private one Markus types
into viaduct.world ("NDC Copenhagen 2026", "Sjælland rundt"); the hashtag is the
public one he posts under (`#kodetoget`, `#nordsjællandrundt`). Nothing links
them, and nothing can: the two strings share no characters.

A mapping table was the obvious answer and is the wrong one — it would need
maintaining by hand, and it would go stale silently the first time he named a
trip one thing and tagged it another. Instead **the public name is simply the
hashtag those posts carry most**, computed from the `trip_posts` join that
already exists. It is derived from data, it updates itself, and a journey whose
posts carry no hashtag honestly reports `tag: null` rather than inventing one.
Ties break on the tag name so the page cannot flip between two equally-used tags
between requests.

### Travel context sits beside a post, never inside it

A post that was written aboard gains one line: *"Om bord · Göteborgs central →
Oslo S · Vy · 346 km"*, with the relation named (`På perrongen før` / `Om bord` /
`Nett komen fram`). Its own element, its own class, and a label that says what
the relation was — because none of it is what the post *said*. The post carries
no station and no operator; this was worked out from when it was published. The
same reason ADR 0020 kept a derived date visibly separate from the note's own.

### Journey pages sit outside the facet system

`/reise` and `/reise/<slug>` are not another filter on the timeline. Every other
view is the same keyset-paged stream under a facet, and its correctness argument
is that `(event_at DESC, ref_id DESC)` is a strict total order over dates. A
journey is a *named set of trips* with its posts gathered under it — a different
shape, and bending facets to carry it would have put a non-chronological
grouping through machinery that assumes chronology. They are separate routes with
their own cache, and they do not page: there are 13 journeys.

The posts on a journey page are rendered by the ordinary `EntryView` via a new
`loadEntriesByRefIds`. A second way to draw a post would eventually disagree with
the first, most likely about a content warning.

### The REST endpoint is the integration surface

`/api/v1/trip-posts` is one row in `src/rest/table.ts`, reusing the same
(schema, handler) pair as the MCP tool. It exists because msge.no consumes the
bot over REST — its `/togselfie` gallery is built from `/actor-posts?tag=togselfie`
— and without it no other site can ever see this data.

## Consequences

- 415 posts across the archive gain their train, and 13 journeys become pages
  with their route, distance, operators and everything published along them.
- **Slugs transliterate rather than percent-encode**: `Sjælland rundt` →
  `sjaelland-rundt`. Lossy on purpose — a slug is only ever compared against
  other slugs, never turned back into a name — and unit-tested as idempotent,
  since the detail page compares a URL segment against freshly-slugged names and
  a slug that re-slugged differently would 404 on its own link.
- Two journeys whose names slug identically collide, and the newest wins. With 13
  hand-typed names this is theoretical; the alternative was a stored slug column
  that could drift from the name it came from.
- `loadJourney` slugs in JS and compares there, because the transliteration is not
  expressible in Postgres without an extension. It therefore loads all journeys to
  resolve one. Fine at 13; it would not be at 13,000.
- The journey cache stores misses as well as hits, so a crawler walking invented
  slugs cannot turn every 404 into two queries.
- **Visibility is enforced at every new surface, not inherited.** `trip_posts`
  deliberately contains links for private posts (ADR 0023), so the journey
  queries, the post count and the hashtag derivation each apply `publicOnlyOn`
  themselves. Verified with a private post sitting on a `#kodetoget` trip: it is
  absent from the page, from the post count, and from the tag vote.
- `idArray` is now exported from `lanes.ts` and reused, with the reason written
  down: interpolating a JS array into `= ANY(${ids})` binds only its first
  element. That is the bug ADR 0023 caught by execution; it is now a shared
  helper rather than a trap two files can fall into separately.
- Verified by execution against Postgres 16 with all 25 migrations: the tag
  derivation, the visibility filtering, the leg ordering, slug resolution, a
  404 on an unknown slug, `if-none-match` returning 304, and the sitemap
  carrying every journey with a `lastmod`.

## Not done here

- **msge.no still shows togselfies without their trains.** The REST endpoint
  unblocks it, but the change belongs in `mmsge/msge-no` — its `/togselfie`
  gallery already carries a hand-tagged `location` per image, and the trip's
  departure station is a strong candidate to prefill it. That is a different
  repo, a different deploy, and its own decision.
- **Weather at the 115 stations**, still. Unchanged from ADR 0023.
