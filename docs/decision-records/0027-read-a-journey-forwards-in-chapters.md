# 0027 — Read a journey forwards: one chapter per leg, oldest post first

- **Status:** Accepted
- **Date:** 2026-08-05
- **Contributors:** Markus (asked for each leg to be a chapter and for the page to run from the start of the journey at the top to the end at the bottom) + Claude (worked out that the leg is already a total grouping of the posts, implemented the chapters and the brief travel line)
- **Affects:** `src/stream/journeys.ts`, `src/stream/views/journey.tsx`, `src/stream/views/entry.tsx`, `src/stream/views/layout.tsx`
- **Topics:** stream, trains, journeys, ordering, ui

## Context

ADR 0024 gave a journey a page: its facts, a numbered list of legs under *Ruta*,
and every post made on the journey under *Undervegs*. The posts were rendered
newest-first, like every other view on meg.msge.no, and in one flat run.

That ordering is right for the timeline and wrong here. A stream is something you
check — the newest thing is the thing you came for. A journey is something you
*read*, and it has a direction: Bergen at 06:19, Oslo at 13:07, København the
next morning. Rendered newest-first, the page told the story backwards, and the
route list at the top told it forwards — the same journey in two directions on
one screen.

The flat run had a second cost. *Undervegs* was one long column with no structure
in it, while the information that would have given it structure — which train each
post was written on — was already sitting on every post, repeated in full under
each one.

## Decision

**The leg is the chapter, the chapters run forwards, and so do the posts inside
them.**

`trip_posts.object_ap_id` is unique (ADR 0023): every post on a journey belongs to
exactly one trip. That is not an approximation to be tuned here — it is the same
total grouping the matcher already committed to, so "which chapter does this post
go in" has one answer, and it is the answer to "which train was I on".

- **`loadJourney` returns each leg with its own `postRefIds`.** One query still,
  with `tp.trip_id` carried along, bucketed in JS. The page does not run a query
  per leg.
- **Every leg is a chapter, including the ones nobody posted on.** Skipping them
  would leave gaps in a route the page has just listed in full. A train ride
  Markus wrote nothing on is a fact about the journey, not an empty slot, and it
  says so: *"Ingenting lagt ut på denne etappa."*
- **Both orderings run forwards.** Legs by departure, posts by publication within
  a leg. The hydrated entries still arrive newest-first from
  `loadEntriesByRefIds` — shared with nothing else that wants them the other way
  round — so the view indexes them by ref id and reads them back in the order the
  leg listed. Reversing the loader would have flipped an ordering the page does
  not otherwise depend on.
- **`Ruta` stays, as the table of contents.** Each entry links to its chapter
  anchor (`#etappe-3`). It is the only place the whole route is visible at once,
  which a chaptered page loses by construction.
- **The travel line inside a chapter is cut down to the relation.** `EntryView`
  takes `briefTrip`, which renders *"Om bord"* without the leg. The chapter
  heading has just named the train, the operator and the distance; repeating them
  under every post is noise. The relation is not — whether he was still on the
  platform or already moving is something only the post can say, and the heading
  cannot.

## Consequences

- The journey page is now the one view on the site that runs oldest-first. That is
  a deliberate exception, written into the view's own docstring, not a drift: the
  facet machinery and its `(event_at DESC, ref_id DESC)` keyset are untouched,
  because journeys were already outside it (ADR 0024).
- A post bound to a leg that has not departed yet would have no chapter to sit in,
  so the post query gained the same `departure_at <= now()` filter the legs query
  already had. Both sides now hide the future identically; a post on a future leg
  is invisible rather than orphaned.
- A journey with many legs and few posts is a longer page than before — every leg
  is a heading whether or not it carries anything. Accepted: the route was already
  listed in full at the top, so no leg is newly on the page, only newly a heading.
- `arrival_at` is now read for the legs, so a chapter can show a span (*06:19 →
  13:07*) rather than an instant. It is nullable in `train_trips`, and where it is
  null the chapter shows the departure alone rather than inventing a duration —
  the same rule ADR 0023 applied to the matching window.
- Two journeys' worth of ordering is asserted in `journey.test.tsx` rather than
  eyeballed: chapters in departure order, posts oldest-first inside a chapter,
  an empty leg still a chapter, and the newest-first input not leaking through.
