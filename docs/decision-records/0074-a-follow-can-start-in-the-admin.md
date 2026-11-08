# 0074 — a follow can start in the admin

**Status:** Accepted
**Date:** 2026-11-08
**Topics:** admin, follows, federation
**Contributors:** Markus (asked for follow, unfollow and retry, on the Følgjer tab and on
the outbox result page) + Claude (proposed and implemented)

**Affects:** `src/admin/follow-admin.ts`, `src/admin/router.tsx`,
`src/admin/category-router.tsx`, `src/admin/views/other-tabs.tsx`,
`src/admin/views/import.tsx`, `src/admin/views/layout.tsx`, `src/activitypub/follow.ts`

## Context

Until now the only way to follow an account was to add it to `FOLLOW_ACTORS` in
`/srv/bot/.env` and restart. Moving to a new NeoDB account (`@markus@neodb.social`) showed
the gap: **Hent utboks** read the new account's outbox and the page offered nothing more,
although a one-off read is not a follow and new posts only arrive from a followed account.

The inbox gate already reads the `follows` table, not the environment. A row with
`status = 'accepted'` is what lets an account's posts in, wherever it came from.

## Decision

**A second way into the same table.** **Admin → Fediverse → Følgjer** gets a form that takes
`@user@host`, `user@host` or an https actor URL, resolves it, and calls the same `sendFollow`
the boot sync uses. Each row gets **Avfølg**, and a follow that is pending or rejected also
gets **Prøv igjen**. The outbox result page shows whether the crawled actor is followed and
offers **Følg** or **Prøv igjen**, drawn from the database alone so no request leaves the box
to render it.

**`FOLLOW_ACTORS` keeps working and still wins on boot.** An unfollow of an account listed
there comes back on the next restart. The row carries a `FOLLOW_ACTORS` badge, and both the
confirm dialog and the notice say so, rather than pretending the unfollow sticks.

**A re-send resets the row.** `sendFollow` now upserts: pending, the new Follow id, a fresh
`followed_at`, and accepted/rejected stamps cleared. Before, a re-sent Follow left the row
saying `rejected` until an Accept arrived. Accept and Reject still match on the actor.

**Refused before anything is queued:** archive actors (ADR 0067, there is no server to dial)
and the bot's own actor. Following an account already accepted or pending changes nothing.

**An unfollow keeps what is stored.** It sends an Undo and deletes the row, which stops
ingest. When the actor cannot be fetched, the row still goes without an Undo, since the row
is what the inbox gate reads.

The POST routes rely on the session cookie being `SameSite=Strict`, like every other admin
form.

## Consequences

- Moving to a new account no longer needs a deploy. Keeping the old one is a matter of not
  pressing **Avfølg**.
- Engagement sampling is untouched: a follow is still not a permission to poll (ADR 0058),
  so a host followed here still needs adding to `ENGAGEMENT_SAMPLE_ORIGINS` to be sampled.
