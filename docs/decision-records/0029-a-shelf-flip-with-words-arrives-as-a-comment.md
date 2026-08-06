# 0029 — A shelf flip with words attached arrives as a Comment, not a GeneratedNote

- **Status:** Accepted
- **Date:** 2026-08-06
- **Contributors:** Markus (reported the gap in the BookWyrm lane, and decided: publish every reading event except want-to-read — ratings and reading-goal notes included; give all five cards a chip, the start card's included) + Claude (found that the missing events were arriving as Comments, worked out the classification order and the dedupe, implemented it)
- **Affects:** `src/stream/reading-events.ts`, `src/stream/lanes.ts`, `src/stream/query.ts`, `src/stream/entries.ts`, `src/stream/views/entry.tsx`, `src/stream/views/layout.tsx`, `src/stream/feed.ts`, `src/stream/sources.ts`
- **Topics:** stream, bookwyrm, reading, activitypub, classification, ui

## Context

The BookWyrm lane on meg.msge.no jumped from 30 June 2026 to 22 July 2026 and
then stopped, while the reader had been posting about books through 5 August. The
store was not missing anything: 1094 reading events for `@mvrkws@bookwyrm.social`,
of which 619 GeneratedNote, 245 Comment, 171 Review, 36 Quotation, 19 Note, 4
Rating. Only the first bucket reached the page.

**The trap, and it is not guessable from the code:** BookWyrm emits no
GeneratedNote at all when a shelf is flipped *with text written in the same modal*.
It posts a single Comment, and the only record that the shelf moved is
`readingStatus` on the AP object — `"reading"` or `"read"`, sometimes as the bare
word, sometimes as the URL of the shelf.

So the lane's gate, which selected `/generatednote/` posts naming "started
reading" or "finished reading" plus `/review/` and `/quotation/`, was not dropping
progress notes as its comment claimed. It was dropping **real starts and
finishes** — specifically the ones the reader had bothered to write a sentence
about. The events that took the most effort were the ones that vanished.

Four events from the live archive, all of which had never rendered:

| Posted | ap_id | `readingStatus` | Is |
|---|---|---|---|
| 2026-08-05 20:57Z | `…/comment/12215917` | `reading` | a start |
| 2026-08-05 20:40Z | `…/comment/12215838` | `read` | a finish |
| 2026-07-11 10:32Z | `…/comment/11994775` | `reading` | a start |
| 2026-07-11 11:01Z | `…/comment/11994931` | `read` | a finish |

The earlier call recorded in `reading-events.ts` — drop rating, comment, note as
bookkeeping — was made on the belief that a comment is a progress note ("på side
120"). Of 60 comments sampled across 2026, **none** is a progress note and every
one carries a shelf state. The premise was simply wrong.

## Decision

**Publish every BookWyrm reading event except want-to-read, and classify it on
what it says rather than on which endpoint it came from.**

Order matters, and it is the whole design. First match wins:

1. `/review/` or `/rating/` → **melding**
2. `/quotation/` → **sitat**
3. carries a finish signal → **lesen ut**
4. carries a start signal → **byrja å lesa**
5. anything left → **kommentar**

A verdict outranks a shelf state: a review that also closes the book stays a
review, and says it closed the book with a marker underneath rather than by
becoming a finish card. A start or finish signal outranks the fact that a post is
"a comment": a Comment carrying `readingStatus: reading` is a start that happens
to have words, not a remark that happens to coincide with one.

Want-to-read stays out in **both** shapes it arrives in — a GeneratedNote saying
so, and a Comment shelved `to-read`. Intent is not activity; the same call as
NeoDB wishlists and planned journeys. Excluding only the note would have let the
same event back in through the door this ADR just opened.

Three details that are load-bearing and easy to undo by accident:

- **A GeneratedNote naming both verbs is a start.** A book opened and closed the
  same day produces one note saying both, and it has always rendered as the start.
  Rule 3 now runs before rule 4, so the guard (`NOT LIKE '%started reading%'`) had
  to move into the finish signal itself, or every such card would have silently
  flipped.
- **A Comment is dated by `published_at`.** BookWyrm sends no `startedDate` or
  `finishedDate` on one, so the lane's `eventAt` keeps both of its coalesce arms
  gated on `/generatednote/`. Widening them would have started reading
  `finishedDate` off reviews and backdating review cards.
- **The body comes from the object's shape, not from the card's kind.** A
  GeneratedNote's text is "Markus started reading X" — the card already says that,
  in Norwegian. Everything else is words Markus wrote. Gating the body on `kind`
  is what would lose a start-via-comment's sentence all over again.

**Deduplication is a lane predicate, never a pass over the results.** Where
BookWyrm emits both a bare note and a comment for one shelf flip, the note is
suppressed by a `NOT EXISTS` inside the lane. Each lane carries its own keyset,
`ORDER BY` and `LIMIT`, so filtering afterwards would return short pages and lose
entries across a page boundary. The rule is deliberately narrow: same actor, same
book, same signal, same Oslo day, and the suppressing comment must pass the same
visibility gate as the row it removes — a followers-only comment may not delete a
public note from the page. A NULL book url on either side fails the comparison and
keeps both cards, which is the safe direction to fail in.

## Consequences

- The lane's classification now lives in one place, `streamReadingKind`, with the
  SQL as its mirror. Three unused mirrors of the same rule
  (`meaningfulReadingCondition`, `readingKindCondition`, `isMeaningfulReadingEvent`,
  `readingEventKind`) were deleted rather than updated; they had no callers and no
  tests, and were exactly the drift hazard the module's own comments worried about.
- `book_comment` is a new stream kind, so `/type/book_comment` exists. It will be
  nearly empty: almost every comment carries a shelf state and therefore renders as
  a start or a finish. It is the fallback that stops anything being dropped, not a
  page.
- Ratings render as **melding** cards with stars and no body. There are four in the
  archive, and none is currently public, so this is code without a picture yet.
- Reading-goal notes now render as **kommentar**. That reverses the earlier call;
  Markus asked for the story's rule list to be followed literally.
- Roughly 7–8 previously-invisible entries a month appear. About half of the new
  finish cards have a body that is nothing but a link to the reader's own
  markus.plus review plus `#BokTut`, and that review is often already a `garden`
  entry in the same stream — so the front page will show some near-duplication.
  Left as it is: the site's posture is what he wrote, unedited, and suppressing a
  body because it is "only" a link is an editorial judgement this codebase does not
  make anywhere else.
- The dedupe may never fire — no same-book, same-day, same-kind note+comment pair
  exists in the sampled history. It is insurance against a double flip. No index
  was added for it: the subquery is bounded by the lane's own `LIMIT` and has
  `objects_actor_published_idx` to sit on. If it shows up in an `EXPLAIN` on the
  box, a partial expression index on `((raw->>'inReplyToBook'), actor_ap_id)` for
  comment rows is the fix.
- `entryTitle` in `feed.ts` has a `default:` arm that narrows to `PostEntry` and
  reads `entry.html`. A new book kind without a `case` there is a type error, not a
  runtime surprise — which is how this change found its own missing case. Keep it
  that way.
