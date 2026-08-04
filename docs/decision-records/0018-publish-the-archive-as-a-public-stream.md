# 0018 — Publish the archive as a public stream on a second host, ordered by when things happened

**Status:** Accepted
**Date:** 2026-08-04
**Topics:** privacy, publishing, web, hono, caching, atom, images
**Contributors:** Markus (asked & decided: a public "here's me" page at meg.msge.no; own original posts only; public-only; event-date ordering with backdated entries sinking, accepted explicitly; filters rather than search; "vis meir" rather than infinite scroll; content warnings collapsed; images hotlinked; threads kept and grouped; a fresh warm look rather than the bot's palette) + Claude (proposed and implemented the two-app dispatcher, the lane merge, the Atom published/updated split, the caching and the diagnostic gate)

## Context

Everything the bot archives has been private. The actor profile said so in as many
words:

> **Ingenting vert delt vidare.** Arkivet er privat, det er ikkje publisert, og det
> vert korkje selt eller utlevert.

Markus wants a page he can hand to anyone: everything he posts across five accounts,
as one coherent stream, rendered better than a Mastodon client would — particularly
for books. That is a new public exposure of a previously private archive, so it
comes with [0017](0017-derive-post-visibility-from-addressing.md), which decides
what may be published at all, and with a rewrite of the profile copy above.

## One process, two sites

`meg.msge.no` is served by the same container as `bot.skvip.lol`, on the same port
3000, with Caddy routing both domains there and the app branching on `Host`. The box
already has this pattern: `mcp.msge.no` and `utrulla.msge.no` share `172.18.0.1:4022`.

The branch is a **dispatcher at `serve()`, not middleware on the existing app**:

```ts
const dispatch = (request, env, ctx) =>
  isStreamHost(request.headers.get('host'))
    ? streamApp.fetch(request, env, ctx)
    : app.fetch(request, env, ctx)
```

With two separate Hono apps the ActivityPub actor, the admin UI and the MCP endpoint
are not merely shadowed on the public host — they are not mounted there. A route
added to the bot app later cannot leak onto `meg.msge.no` by accident, which a
middleware guard could not promise.

Two details are load-bearing:

- The `Host` header is read, never `X-Forwarded-Host`. The latter is caller-supplied
  and would let anyone choose which site they get; Caddy passes `Host` through.
- **An unknown or missing Host falls through to the bot app.** The container
  healthcheck calls `http://127.0.0.1:3000/healthz`; flipping the default would have
  the probe answered by the wrong app.

`STREAM_DOMAIN` unset disables the stream entirely — no route answers. That is the
off-switch: it lets the whole feature ship, deploy and be verified against real data
before anything is publicly visible, and it takes the site down later without
touching Caddy.

## Ordered by when things happened

Entries are ordered by their event date, not their post date: a film marked today
but watched in 2016 belongs in 2016 (`watched_at`, per [0012](0012-surface-the-mark-shelf-date.md)),
a book by the reader's own recorded dates, a scrobble digest by its Oslo day.

Markus was told the cost and accepted it: a backfill of old marks lands invisibly,
because it sorts to where it belongs rather than to the top. There is no
"recently added" strip.

Entries with **no derivable date are excluded**. That is not tidiness — it keeps
`(event_at DESC, ref_id DESC)` a strict total order, which is the precondition for
the keyset paging to be correct. With nullable dates the ordering has a tail whose
membership shifts as rows arrive, and a cursor into it skips or repeats entries.

## The query is a k-way merge, not a union

Six unrelated tables, one timeline. The obvious shape — union everything, filter and
sort at the top — does not survive the scrobble lane: the planner will not push a
qualifier on a derived grouping expression into a `GROUP BY`, so every request would
sort the whole 51k-row listening history to return twenty rows.

Instead each lane carries the keyset predicate and its own `LIMIT`, hits its own
index, and returns at most n; the ≤6n candidates are merged, sorted and cut. Lanes
are disjoint by actor, which is what stops a post being counted twice. Lanes emit
only `(event_at, kind, ref_id, source)`; the winners are hydrated afterwards, one
query per kind — a wide union carrying every column of six tables would be slower
and much easier to get a privacy rule wrong in.

`ref_id` is a synthetic `"<kind>:<id>"` text tiebreaker, compared and ordered with
`COLLATE "C"` so the ordering is byte-stable regardless of the database's
`lc_collate`. The per-lane `ORDER BY`, the merge `ORDER BY` and the keyset
comparison must agree exactly or a page boundary lands where the cursor does not
expect it.

## What is excluded

Replies to other people, boosts, anyone else's posts, unlisted and private posts,
bare BookWyrm ratings, BookWyrm's automatic progress notes, NeoDB wishlist marks
(intent, not activity), hidden catalogue rows ([0013](0013-hide-media-rows-instead-of-deleting.md)),
soft-deleted rows, and — by default — scrobbles older than
`STREAM_SCROBBLE_CUTOFF_MONTHS`. That last one is not squeamishness: 51k scrobbles
since 2016 is more daily digests than Markus has posts, and without a cutoff the
deep archive reads as a listening log with the occasional thought in it.

## Content warnings

Honoured, which the brief did not ask for. `objects.sensitive` and `summary` have
been stored since the beginning and read by nothing. A public page that ignores a
warning its author set is worse than one that never had it, so the body collapses
behind `<details>` — no JavaScript — and the media is withheld too, since a photo
is as much "the content" as the words are.

The same rule applies in the feed, including the entry **title**: deriving the title
from the post text put the withheld body straight back into the one field every
reader displays. A test caught that.

## The feed: published vs updated

Event-date ordering creates a problem for subscribers. A mark backdated to 2016
enters the feed dated 2016, and every reader sorts by `updated`, so it would arrive
already buried nine years deep and nobody would ever see it.

Atom separates the two, so:

- `<published>` is the event date — matching the website.
- `<updated>` is when the entry entered the archive.
- **Feed entries are ordered by `updated`; the website is ordered by `published`.**

Both are true, and each audience gets what it expects. This is the main reason for
Atom over RSS, which has only `pubDate`. The others: Atom requires a globally unique
`<id>` per entry, which a scrobble digest needs since it has no URL of its own, and
`<link rel="alternate">` is per-entry, so each one points at its origin.

## Images, and an honest colophon

Post media and cover art stay on their origin CDNs. Markus chose hotlinking, and the
cost is real: reading the page makes requests to skvip.lol, Pixelfed, Loops,
BookWyrm, NeoDB and Last.fm's CDN. The site is otherwise fully self-contained — no
external stylesheet, font or script, the same principle as `page-chrome.ts` — so the
colophon says out loud that images are fetched from elsewhere rather than implying
otherwise by omission. Every `<img>` carries `referrerpolicy="no-referrer"`.

A caching image proxy would let the CSP tighten to `img-src 'self' data:` and make
the claim checkable with a single `curl … | grep`. It is recorded here as the
intended next step, not as something this record decides against.

Video is a poster frame linking out, never an inline player: proxying video on two
vCPUs is not viable, and an embedded remote player is a heavier third-party load
than an image.

## Caching

A rendered page and its ETag are cached for `STREAM_CACHE_TTL_SECONDS` (180 s), in a
bounded TTL map with single-flight loading — without that, a cold key under a burst
runs the query once per request, exactly when it is most expensive.

The 200-entry cap is a backstop. The real defence is that `facets.ts` normalises
every filter to a closed enum and **rejects the unknown before the cache is
consulted**, so a crawler varying the query string cannot mint unbounded entries.
`limit` is server-fixed. Budget is roughly 16 MB across both layers, which the box
can afford.

`robots.txt` disallows `/*?etter=`: the cursor space is unbounded and self-similar,
and a crawler walking it would page the whole archive one request at a time.

## Rendering federated HTML

`objects.content` is HTML written by five different servers and stored verbatim.
This is the first time it reaches an untrusted reader, so it goes through an
allowlist sanitiser: a small set of tags, every attribute dropped, `href` checked
for `http(s)`. The Caddy CSP is the backstop, not the defence — a page that relies
on CSP alone is one misconfigured header away from executing whatever a federated
server chose to send.

## Consequences

- The profile page's privacy copy is rewritten. The claim about *other people*
  stays true and is now the load-bearing one.
- No per-entry permalinks and no free-text search, both Markus' calls. Every shared
  link previews as the page it was shared from; per-entry `id` anchors and a sitemap
  of filter and archive views are the partial mitigation.
- `meg.msge.no` is not itself an ActivityPub actor. People follow the five real
  accounts, linked in the header, or the Atom feed.
- The bot host now serves `robots.txt` and `sitemap.xml` too, closing an existing
  gap against the box's `NEW-SERVICE.md`.
