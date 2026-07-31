# 0014 — Make the account visible: fix discovery, and give the actor something to show

**Status:** Accepted
**Date:** 2026-07-31
**Topics:** activitypub, actor, discovery, federation, privacy
**Contributors:** Markus (asked & decided: the bot should publish status notes, and the outbox should serve only its own posts — follows stay auto-rejected) + Claude (found the outbox leak, proposed and implemented the discovery fixes)

## Context

[0010](0010-profile-page-must-resolve-to-the-actor.md) made the profile URL
dereference back to the actor. The account still read as dead: on a Mastodon
client the profile showed nothing, and searching the profile URL turned up
nothing.

Probing the live deployment split the problem in two.

**Half the discovery surface was missing.** `/.well-known/nodeinfo` 404'd — the
NodeInfo router was mounted at the bare `/nodeinfo`, which is not where anything
looks. `/.well-known/host-meta` did not exist. WebFinger accepted exactly one
byte-identical `acct:` string, so every URL-form and bare-handle lookup 404'd.
The actor had no `indexable`, and no `featured` collection.

**And the actor had never published anything.** Grep for an outbound `Create`
across `src/` returned nothing; the only activities ever enqueued were `Follow`,
`Undo{Follow}` and `Reject{Follow}`.

## The trap

Two of these are worth spelling out, because neither shows up as an error
anywhere.

**The outbox was serving the inbox.** `outbox.ts` selected from the `activities`
table — which is the archive of what the *followed accounts* sent us — and
returned it as `orderedItems`. So every unauthenticated fetch of
`/actor/outbox` republished other people's activities as if this actor had
authored them. The profile page said the opposite in as many words: *"Postar
ingenting. Utboksen er tom."* Nothing failed; the endpoint returned 200 and
looked plausible. It was the privacy claim, not the code, that was broken.

**`indexable` is not optional-by-omission.** Mastodon 4.2+ reads a missing
`toot:indexable` as an explicit *no* and keeps the profile and its posts out of
search entirely. An actor can be perfectly resolvable and still be unfindable
by anything except its exact handle.

There is also a shape trap: the outbox returned a bare `OrderedCollectionPage`
at the collection URL, with no `totalItems` anywhere. Crawlers read the item
count from the collection entry point and follow `first` only if they want the
contents, so they saw an account with no measurable output.

## Decision

**Complete the discovery surface.**

- NodeInfo answers at `/.well-known/nodeinfo` as well as `/nodeinfo`, advertises
  2.0 and 2.1, and carries the fields validators require (`services`,
  `metadata`, `usage.users.activeMonth`/`activeHalfyear`). `localPosts` is the
  real count, and answers 0 rather than 500 when the database is unreachable —
  crawlers hit this unauthenticated and often.
- `/.well-known/host-meta` and `host-meta.json` serve the LRDD template. This is
  the hop Friendica, GNU Social and several WebFinger clients take *before*
  WebFinger, and they give up on the account when it 404s.
- WebFinger accepts the `acct:` URI, the bare `user@domain`, and all three of
  the actor's URLs, case-insensitively — and always answers with the canonical
  `acct:` subject, because implementations re-finger what they get back.
- The actor declares `indexable: true` and a `featured` collection.
- `/actor` and `/@<username>` send `Vary: Accept`. Both serve two
  representations; without it a shared cache may hand a fediverse server the
  page a browser asked for.
- Every collection answers under `/users/<name>/…` as well as `/actor/…`, with
  the canonical ids in the body. Only the inbox had an alias before.

**Publish, in the narrowest form that is still true.** The bot writes two kinds
of note, both about itself: a pinned intro, and a periodic status giving the
size of its own archive (accounts followed, posts archived, oldest post — all
aggregates over Markus' own accounts). They live in a `local_notes` table,
deliberately separate from `objects`, so the bot's own output can never leak
into the archive that every reading/music/film aggregation reads from.

`/actor/outbox` now serves those notes and nothing else, as an
`OrderedCollection` with `totalItems` and `first`, paged at `?page=N`.

**`featured` is the delivery mechanism.** Follows stay auto-rejected, so there
are no followers and nothing is queued for delivery. Mastodon refetches
`featured` on every account discovery and refresh and renders what it finds at
the top of the profile — so pinning the intro there is what puts a readable post
in front of a stranger without accepting a single follower. The notes are
embedded in that collection rather than listed as URIs, saving a fetch per note
per refresh.

## Consequences

- The profile page's "Postar ingenting. Utboksen er tom." was true of the
  intent and false of the behaviour; it now says the bot posts only about
  itself. Same correction in the actor's bio. **If the notes are ever
  disabled, that copy has to move back** — the rule is that the page describes
  what the endpoints do, not what we meant them to do.
- A regression test rigs `getDb` to throw inside the outbox suite, so any future
  query outside the notes store fails the build rather than quietly reopening
  the leak.
- `STATUS_NOTE_INTERVAL_HOURS` (default 168) is a *floor*, not a schedule: an
  unchanged status never reposts, and no status publishes at all while there is
  nothing to report. The pinned intro is rewritten in place when its wording
  changes, never duplicated.
- Federation still has no fan-out. If follows are ever accepted, the delivery
  path for `Create` has to be built — `deliver.ts` takes one explicit inbox URL
  per row and has no notion of a followers collection.
- Any new human-facing route the actor advertises still needs 0010's treatment.
  `/notes/<id>` gets the mirror-image rule of `/@<username>`: it defaults to
  JSON, because that URL is the note's ActivityPub `id` and a server
  dereferencing it may send nothing more specific than `Accept: */*`.
