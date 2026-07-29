# 0009 — Publish an informative actor profile, and prune the request log so its privacy claim stays true

**Status:** Accepted
**Date:** 2026-07-29
**Topics:** activitypub, actor, privacy, retention, federation
**Contributors:** Markus (asked & decided: nynorsk, precise/verifiable privacy wording, credit `@markus@skvip.lol` as operator, bot badge + images + metadata fields + readable page) + Claude (proposed/implemented, and found the retention gap)

## Context

The actor document published a single English sentence — "Personal ActivityPub
bot. Follows and archives public posts." — with `type: Person`, no avatar, no
header, no metadata fields and no link back to its operator. Anyone who saw it
in their notifications (it federates Follow requests, so it does show up) had no
way to tell whose it was, what it did, or whether it was hoarding their posts.

Markus asked for a profile that answers those three questions, in nynorsk, with
the privacy claim stated precisely rather than as vague reassurance.

## The traps

Four things here are non-obvious and easy to get wrong or silently undo:

1. **Content negotiation defaults to JSON, not HTML.** `/actor` now serves the
   readable page to browsers, but only when `Accept` explicitly contains
   `text/html`. Plenty of fediverse implementations send a vague `Accept: */*`
   or no `Accept` at all and expect the actor document. Flipping the default —
   "HTML unless activity+json is requested" — silently breaks federation for
   those servers. `src/activitypub/router.test.ts` pins the `*/*` case.

2. **Mastodon rejects SVG avatars.** Its media validator only accepts raster
   image types, so an SVG `icon` fails silently and the profile keeps showing
   the default placeholder. The artwork therefore has to ship as PNG. It is
   generated from signed distance fields in
   `scripts/generate-profile-images.ts` using only `node:zlib`, so it stays
   editable as code rather than as committed binaries nobody can regenerate.

3. **Mastodon does not revalidate cached remote avatars.** It re-downloads only
   when the URL *string* changes. A stable `/assets/avatar.png` would mean
   regenerated artwork never reaching instances that already know us, so the
   actor document appends a content hash (`?v=<sha256[0:12]>`), letting the
   bytes be served `immutable` with a one-year `max-age` while still
   propagating changes.

4. **The request log made the privacy claim false.** This is the one worth
   remembering. `handleInbox` already discards activities from actors we do not
   follow — but it does so *after* writing every inbound request to
   `activity_log`: headers plus the first 10 kB of body, including requests
   whose signature failed. That is deliberate and useful (it is what makes
   federation debuggable, and the admin Logs page depends on it), but nothing
   ever pruned the table. So the server did in fact retain data about people it
   does not follow, indefinitely, and a profile promising otherwise would have
   been lying.

## Decision

1. Actor document: `type: Service` (bot badge), a three-paragraph nynorsk bio,
   `attachment` PropertyValue rows capped at the four Mastodon renders, generated
   `icon`/`image`, plus `url`, `published`, `attributedTo`, `discoverable` and
   `manuallyApprovesFollowers`. The last is the closest AS2 signal to "never
   followable" — there is no term for auto-rejecting every Follow, which is what
   `handlers/follow.ts` actually does, so the bio and page say so in words.

2. Serve the long-form explanation as HTML at `/@<username>` (advertised as the
   actor's `url`, and linked from WebFinger as `profile-page`), with `/actor`
   content-negotiated as described above.

3. Add `pruneActivityLog` on a 6-hourly timer and at startup, bounded by
   `ACTIVITY_LOG_RETENTION_DAYS` (default 30). Only the log is pruned; the
   archive itself is the point of the service and is kept.

4. Word the claim to match what is enforced. The bio says **"arkiverer
   ingenting om deg"** ("archives nothing about you") rather than "lagrar"
   ("stores"), because the archive genuinely holds nothing from unfollowed
   actors while the debug log briefly does. The metadata row spells the window
   out — "Ingenting — berre ein teknisk logg i 30 dagar" — and interpolates the
   configured value, so the claim cannot drift from the retention actually
   running.

## Consequences

- Setting `ACTIVITY_LOG_RETENTION_DAYS=0` disables pruning and makes the
  published claim untrue. The env var is documented as such in the README, and
  the metadata row degrades to "Berre ein teknisk logg" (no window promised)
  rather than continuing to advertise a number nothing enforces.
- The four-field cap on `attachment` is a Mastodon rendering limit, not an
  ActivityPub one. Adding a fifth row means the least important one stops being
  shown, so the ordering (operator → what it stores about you → what it fetches
  → public following list) is deliberate.
- `OWNER_ACTOR` now affects the public profile, not just the default scope of
  the hashtag tools. When it is unset the profile still renders, just without
  the operator credit and `attributedTo`.
- The profile page is deliberately self-contained (no external stylesheet, font
  or script), so it renders identically regardless of the box's egress policy.
