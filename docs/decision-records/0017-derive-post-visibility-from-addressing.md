# 0017 — Derive post visibility from ActivityPub addressing, in a generated column that fails closed

**Status:** Accepted
**Date:** 2026-08-04
**Topics:** privacy, activitypub, visibility, addressing, postgres, generated-columns
**Contributors:** Markus (asked & decided: publish only posts that were already public at their origin, and withhold anything whose visibility cannot be proven) + Claude (proposed and implemented the generated column, the fail-closed rule and the diagnostic)

## Context

Until now the archive was never read out to anyone. Every path into `objects` sat
behind an API key, an OAuth token or an admin session, so no query in this repo had
to care who a post had been addressed to. [0018](0018-publish-the-archive-as-a-public-stream.md)
changes that: `meg.msge.no` republishes Markus' own posts on a public, indexed page.

Two facts make that more dangerous than it first looks.

**The bot is an accepted follower of all five accounts.** It is not reading public
timelines; it is receiving deliveries as a follower. So followers-only posts really
are in `objects`, sitting next to public ones with nothing on the row to tell them
apart.

**`objects` is not "Markus' posts".** `handlers/announce.ts` unwraps a boost and
stores the inner object under its *original author's* `actor_ap_id`. Anything Markus
has ever boosted is therefore in the archive under a stranger's name. The account
allowlist in `STREAM_SOURCES` is a second, independent control for exactly this, and
`actors.software` cannot substitute for it — it is nullable, and boosted strangers
have `actors` rows too.

## The rule

All five platforms (Mastodon, Pixelfed, Loops, BookWyrm, NeoDB) are
ActivityStreams-2.0 conformant and use the same four-level convention:

| Visibility | `to` | `cc` |
|---|---|---|
| public | contains `…#Public` | followers |
| unlisted | followers | contains `…#Public` |
| followers-only | followers | — |
| direct | specific actors | — |

Three lexical forms of the Public marker are legal depending on how the sender
compacted its JSON-LD (`https://www.w3.org/ns/activitystreams#Public`, `as:Public`,
bare `Public`), and either field may be a bare string rather than an array.

`objects.visibility` is a **STORED generated column** over `raw->'to'` and
`raw->'cc'`, mirrored in TypeScript by `classifyVisibility` in
`src/stream/visibility.ts`. `jsonb @> '"literal"'::jsonb` handles scalar-and-array
in one expression, and both `@>` and `?` are IMMUTABLE, which a generated column
requires.

## Why generated, and not a plain column filled on ingest

There are five ingest entry points — `handleCreate`, `handleAnnounce`,
`handleUpdate`, the two outbox crawls and the admin archive import — and all of them
funnel through one upsert that rewrites `raw`. A generated column recomputes on
every one of them, including edits and re-ingests, and cannot drift out of step with
the data it describes.

A plain column plus a backfill would need each of those paths to remember to
maintain it. Forgetting would be silent, and the failure mode is publishing a
private post. The same argument as [0001](0001-refresh-structured-fields-on-edit.md),
with worse consequences.

Being a real column also means it is indexable — the stream's partial index is on
`(actor_ap_id, published_at DESC) WHERE visibility = 'public' AND deleted_at IS NULL
AND in_reply_to IS NULL` — and that it shows up in every `SELECT *`, so a reviewer
can see whether a new query forgot to filter on it.

The cost is an `ALTER TABLE … ADD COLUMN … GENERATED … STORED`, which takes an
ACCESS EXCLUSIVE lock and rewrites the table including TOAST. At this size that is
seconds, it runs in `migrate.ts` before the port binds, and the compose healthcheck
has a 180 s start period.

## Fail closed

Only an explicit Public marker in `to` yields `public`. Everything else is withheld:

- **`unknown`** — no `to` and no `cc` we can read — is *not* public. A bare or
  stripped object is one we cannot prove anything about, and a parsing gap must
  cost us a post on the page, never leak one.
- **`unlisted`** is excluded by default. An unlisted post was deliberately kept off
  public timelines at its origin; republishing it on an indexed page is the opposite
  of that choice. `STREAM_INCLUDE_UNLISTED` exists as an escape hatch and is not
  `z.coerce.boolean()` — that is `Boolean(string)`, so the literal `"false"` would
  read as true and publish unlisted posts because someone tried to turn the flag off.

The TypeScript twin reads **own properties only**. `raw->'to'` in Postgres reads the
key that is actually there, so a prototype-chain lookup would let the two
implementations disagree — and disagree in the dangerous direction, since an
inherited `to` would read as public. The property test caught exactly that.

## Replies

`in_reply_to IS NULL` selects thread roots. This is safe for BookWyrm: a review
references its book through the separate `inReplyToBook` field and has a null
`in_reply_to`, so reviews are not mistaken for replies.

Markus' own threads are kept, and grouped into one entry rather than appearing as
separate rows. A self-reply is detectable because every archived post is keyed by
actor: a reply whose parent is another publishable post by the same account is a
continuation, and a reply to anyone else is not. The thread is walked level by level
— the third post of a thread replies to the second, not to the root — and a part
whose parent is not publishable stops the walk, taking its descendants with it.

## Verifying it

`/admin/visibility` shows counts per account and classification, a sample of
withheld rows with their raw `to`/`cc`, and a sample of what will be published with
links to the origins. It is meant to be read once with `STREAM_DOMAIN` still unset,
and again a week after launch: a growing `unknown` count means a platform has
changed how it serialises addressing, and the fail-closed default is quietly costing
us posts.

## Consequences

- Some genuinely public old posts may be withheld until they are re-fetched, if the
  stored `raw` predates a full serialisation. That is the intended direction of
  error.
- A NeoDB mark whose federating Note is not stored can never be published: the
  marks lane joins `objects` with an INNER join, because without the Note there is
  no visibility to read. The diagnostic counts these so the number is known.
- Every future query that reads `objects` for public consumption must filter on
  this column. The SQL-shape tests assert it per lane.
