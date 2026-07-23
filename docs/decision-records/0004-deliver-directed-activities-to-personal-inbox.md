# 0004 — Deliver directed activities to the personal inbox, with explicit `to`

**Status:** Accepted
**Date:** 2026-07-23
**Topics:** activitypub, follow, federation, neodb, interop, delivery
**Contributors:** Claude (agent decision — Markus reported that a new follow was silently not landing and approved opening the PR; the personal-inbox + addressing fix was an agent decision)

## Context

`sendFollow` (`src/activitypub/follow.ts`) delivered the `Follow` to
`sharedInboxUrl ?? inboxUrl` — i.e. the origin's **shared** inbox when it
advertised one — and the activity carried no `to`/audience field, only `actor`
and `object`.

That works with Mastodon, Pixelfed, BookWyrm and Loops (they route a
shared-inbox `Follow` by its `object`), so all four of Markus's accounts reached
`accepted`. Adding **NeoDB** (`@markus@minreol.dk`, movies/TV) surfaced the
problem: the `Follow` was delivered to `https://minreol.dk/inbox/` and got a
bare `202`, but for ~10 minutes NeoDB never reached back — no signature-verify
fetch, no `Accept` — and the account showed neither a follower nor a pending
request, even though it is open (`manuallyApprovesFollowers: null`). A re-send
aimed at the **personal** inbox (`.../@markus@minreol.dk/inbox/`) with a `to`
field was answered within seconds and the follow flipped to `accepted`.

The original delivery, in hindsight, was *also* eventually answered — NeoDB's
inbox worker was mostly just slow — so the two paths' contributions are
ambiguous. Either way the shared-inbox-without-addressing path is the fragile
one, and there is no reason to use it for a `Follow`.

## Decision

**Directed activities go to the recipient's personal inbox and name the
recipient in `to`.** A `Follow` (and its `Undo`) has exactly one recipient, so
the shared inbox — an optimisation for fanning one activity out to many local
users — buys nothing and only adds a code path where a server must infer the
recipient. `sendFollow` now:

- delivers to `inboxUrl` (the actor's personal inbox), dropping the
  `sharedInboxUrl` parameter entirely, and
- includes `to: <actorApId>` on the `Follow`.

`sendUnfollow` already used the personal inbox; it now also carries `to` for
symmetry. Personal-inbox delivery is strictly safe across every server we
target (the personal inbox always accepts a directed activity), so this is not
NeoDB-specific special-casing — it's the more correct default.

## The trap (don't re-derive this)

- **A `202` from a shared inbox is not acceptance.** Shared-inbox delivery is
  fire-and-forget: the server queues the activity and returns `202` before it
  attributes it to a local user. If it can't (no `to`, and it doesn't route
  `Follow` by `object`), it drops the activity **silently** — the follow sits
  `pending` forever with a clean delivery log. Confirm a follow by the inbound
  `Accept` / `follows.status = accepted`, never by the outbound `202`.
- **Don't reintroduce shared-inbox delivery for directed activities.** It only
  helps when one activity has many recipients (e.g. a public post to all
  followers). A `Follow`/`Undo` never does.
