# 0026 — The REST API serves public posts only; MCP still sees the whole archive

- **Status:** Accepted
- **Date:** 2026-08-05
- **Contributors:** Markus (asked for the fix, and confirmed every `#togselfie` is public anyway) + Claude (found the gap while scoping the msge.no follow-up, proposed the split, implemented it)
- **Affects:** `src/mcp/tools/scope.ts`, `src/rest/table.ts`, `src/mcp/tools/actor-posts.ts`, `src/mcp/tools/actor-media.ts`, `src/mcp/tools/actor-search.ts`, `src/mcp/tools/trip-posts.ts`, `src/jobs/visibility-audit.ts`
- **Topics:** rest, mcp, privacy, visibility, postgres

## Context

ADR 0017 gave every archived post a `visibility` column derived from its
ActivityStreams addressing, and made it fail closed: only an explicit Public
marker in `to` yields `public`. ADR 0018 made the public stream carry that
predicate in every lane.

The REST API never got it. Four endpoints return rows out of `objects` —
`/actor-posts`, `/actor-media`, `/search-actor-content` and the `/trip-posts`
added by ADR 0024 — and none filtered on visibility. None even *returned* the
field, so a consumer could not have filtered downstream if it wanted to.

That matters because the archive really does hold non-public posts. The bot is an
accepted follower of Markus' accounts, so a followers-only post is delivered and
stored like any other. And msge.no builds its `/togselfie` gallery from
`/actor-posts?tag=togselfie` and republishes the result on a world-readable page.
The path from "post something followers-only with that hashtag" to "it is on the
public web" had no gate anywhere along it.

That msge.no's *other* feed guards this exactly right is what settles it as an
oversight rather than a decision: `server.js` builds `/data/skvip.json` from
Mastodon's own API behind an allowlist whose comment says followers-only,
unlisted "and any future visibility value can never leak into the world-readable"
file. The togselfie path arrived later, through this bot, and never got the same
treatment.

Markus confirms every `#togselfie` he has posted is public, so this is a latent
exposure rather than a live leak. It is being closed while that is still true.

## Decision

**Split the two surfaces: REST is pinned to public-only, MCP keeps the whole
archive.**

The two have different audiences and must not return the same rows.

- **MCP is Markus reading his own archive.** The followers-only posts are the
  point of keeping it. Filtering here would make his own tooling lie to him
  about what he has written.
- **REST is what other sites republish.** It must be safe for a consumer that
  does no filtering of its own, because msge.no is exactly that consumer and the
  next one will be too.

The mechanism is a **second argument, not a schema field**:

```ts
export async function getActorPosts(input, scope?: QueryScope)
```

A query parameter would let any caller holding `REST_API_KEY` ask for private
posts, which is the door being closed. `QueryScope` cannot be set from outside
the process. The REST table binds it:

```ts
handler: publicOnly(getActorPosts),
```

**`unlisted` and `unknown` are both withheld**, matching the stream. An unlisted
post was deliberately kept off public timelines at the origin, and republishing it
on an indexed page overrides that choice; `unknown` is addressing we could not
read, which is not evidence of anything. Verified against all four classes.

This **breaks the invariant `rest/table.ts` used to state** — that REST and MCP
return identical data. That comment is now rewritten to say where and why they
diverge, because the alternative is a future reader finding the difference and
assuming a bug.

## Consequences

- The four post-serving endpoints stop returning non-public rows. Any consumer
  sees fewer items on its next poll; msge.no's togselfie gallery refreshes within
  ~15 minutes of deploy.
- **In practice, today, nothing changes.** Every `#togselfie` is public, so the
  gallery is unaffected. `npm run visibility-audit` prints the real number.
- The filter is a condition, not a post-filter, so `limit` still counts rows the
  caller may see and pagination does not return short pages.
- **The change is otherwise invisible**, which was the main risk: a consumer just
  receives less, with no error and nothing in a log. `jobs/visibility-audit.ts`
  exists for that — it counts posts per visibility class, per watched hashtag and
  across the trip join, so any shrinkage is a number that was approved rather than
  something noticed weeks later.
- A fifth endpoint returning post rows must be wrapped too. That is why the
  wrapper sits in the table where an endpoint is declared public, rather than
  being a rule each handler has to remember — an unwrapped row is visible in the
  diff, a forgotten `if (scope)` inside a handler is not.
- Endpoints that do not serve `objects` rows are untouched: reading events, marks,
  scrobbles, trips, garden and the stats tools. Several read from `objects`
  indirectly through their own tables; those are BookWyrm and NeoDB material,
  which is public by construction. Worth re-checking if that ever stops being true.
- Nothing is deleted and no migration runs. Fully reversible by redeploy.
- Verified by execution against Postgres 16 with fixtures covering all four
  visibility classes — public, followers-only, unlisted and unaddressed — through
  each handler twice (MCP scope and REST scope) and then through the actual
  `endpoints` table entries, which is the wiring production uses.
