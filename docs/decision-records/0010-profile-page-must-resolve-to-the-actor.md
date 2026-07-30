# 0010 — The profile page URL must resolve back to the actor

**Status:** Accepted
**Date:** 2026-07-30
**Topics:** activitypub, actor, discovery, federation
**Contributors:** Claude (agent decision — no human input on the technical choice; Markus reported the symptom: the account did not show up when searching its URL on Mastodon)

## Context

[0009](0009-actor-profile-and-log-retention.md) added a human-readable profile
page at `/@<username>` and advertised it as the actor's `url` (and as WebFinger's
`profile-page` link). That route served HTML unconditionally — a deliberate
choice at the time, and even pinned by a test named "always serves the profile
page".

After deploy, pasting `https://bot.skvip.lol/@mcp` into Mastodon's search
returned **No results**, under Profiles and everywhere else.

## The trap

Searching a URL on Mastodon does not do a text search. It hands the URL to
`FetchResourceService`, which fetches it with
`Accept: application/activity+json, application/ld+json` and expects an
ActivityPub object back. When the response is HTML instead, it falls back to
scanning that HTML for a `<link rel="alternate" type="application/activity+json">`
and follows it.

Our page satisfied neither path: it returned HTML no matter what the caller
asked for, and the HTML had no alternate link. So the URL the actor itself
publishes as its `url` resolved to nothing, and the account was unfindable by
link — even though WebFinger, the actor document and handle search were all
fine. This is why the failure was invisible in testing: `@mcp@bot.skvip.lol`
resolved perfectly, and the page rendered perfectly in a browser. Only the
combination — an ActivityPub client dereferencing the human URL — was broken.

Note the asymmetry with `/actor`, which defaults to JSON and yields HTML only on
an explicit `text/html`. The human URL needs the mirror image of that rule, not
the same rule, so the two routes cannot share one helper without care.

## Decision

Make the page reachable back to the actor by both mechanisms Mastodon tries:

1. `/@<username>` content-negotiates — HTML by default, but the actor document
   when the caller explicitly asks for ActivityPub **and not** HTML. The
   `!prefersHtml` half matters: a client sending
   `Accept: text/html, application/activity+json` is a browser, and should get
   the page.
2. The page carries `<link rel="alternate" type="application/activity+json">`
   pointing at `/actor`, plus a `rel="canonical"` self-link, for clients that
   only parse HTML.

Both are covered by tests in `src/activitypub/router.test.ts`, including the
exact `Accept` header Mastodon sends, so collapsing the route back to a bare
`c.html(...)` fails the suite rather than silently delisting the account.

## Consequences

- The account resolves from its URL as well as its handle. Existing instances
  that already cached a failed lookup may need the search repeating.
- Any future human-facing route that an actor advertises (`url`, `attributedTo`,
  a post permalink) needs the same treatment. "It renders fine in a browser" is
  not evidence that a fediverse client can dereference it.
- `isActivityPubRequest` from `lib/content-type.ts` is now used for a route that
  *prefers* HTML, so read the `!prefersHtml` guard as part of the rule rather
  than an optimisation.
