# 0057 — Store the shape of a conversation, not its words

**Status:** Accepted
**Date:** 2026-08-28
**Topics:** mastodon, threads, privacy, schema, backfill, watchers

**Contributors:** Markus (asked & decided: no stored data about other people, but a full
reply tree and the list of participants; both tools on the REST API as well as MCP; an
`/admin/threads` page alongside the walker) + Claude (proposed and implemented the
shape/content split, the one-request-per-root walk, the settle window and the CHECK
constraints)

**Affects:** `src/lib/thread-context.ts`, `src/lib/thread-fetch.ts`,
`src/lib/thread-store.ts`, `src/jobs/walk-threads.ts`, `scripts/walk-threads.ts`,
`src/mcp/tools/thread-leaderboard.ts`, `src/mcp/tools/thread-tree.ts`,
`src/db/schema.ts`, `drizzle/0040_thread_shape.sql`, `src/rest/table.ts`,
`src/admin/router.tsx`, `src/jobs/scheduler.ts`

## Context

`replies_count` on a Mastodon status counts **direct children only**. A toot with four
replies that each spawned a long argument scores 4; one with thirteen flat one-liners
scores 13. On tree size the first is several times the second, and nothing in this repo
could see the difference.

The honest answer needs `/api/v1/statuses/:id/context` per root. Against roughly two
thousand root toots that is far too slow to do when someone asks, so it has to be walked
in the background and stored.

Which runs straight into the thing Markus actually asked for, twice, in the same
sentence: **no stored data about other people**, and **the full reply tree with the list
of participants**. Those pull against each other only if "the thread" is taken to mean
the posts. It isn't. What answers the question is the graph.

## Decision

### Store the shape; the origin keeps the words

A node is: status id and origin host, permalink, parent id, depth from the root, publish
time, participant handle, and a flag for mine-or-theirs. That is the whole record.

Never stored: reply text, content warnings, `summary`, attachments, alt text, media URLs,
display names, avatars, bios, follower counts, or anyone else's favourite and boost
counts. No profile lookup happens during the walk — the handle comes from the `acct` the
context response already carried.

The handle, as `@user@host`, is the only piece of data about an external person kept
anywhere. It is what makes "how many distinct people took part" answerable and what lets
a rendered node be attributed; there is nothing else about them to know from this
database.

The result is a skeleton. Whatever renders it reads the shape from `thread_nodes` and
fetches each post live from its origin instance when a node is opened, so nobody else's
words ever come to rest here.

### Criterion 7 is a schema property, not a rule people remember

"There is no content column" is a fact about today's tables. A rule has to survive the
next person with a good reason, so it is enforced twice:

**Every text column carries a CHECK that makes prose impossible in it.** `handle` matches
`^@[^@[:space:]]{1,64}@[a-z0-9.-]{1,253}$` and nothing else; ids and URLs must be
`^https?://\S+$` under 500 characters; `status_id` is `^[A-Za-z0-9_-]{1,64}$`; `origin`
is a hostname. There is no column in either table that a sentence fits into. The one
free-text field, `walk_error`, holds *our* message about a failed fetch and is
length-bounded.

**The column set is pinned by a test.** `src/db/thread-schema.test.ts` asserts both
tables' columns exactly, and separately rejects any column named after something a post
carries. Adding `content` fails CI rather than passing review.

Either layer alone is a convention. The pair is enforcement: the test stops a new column,
the constraints stop the existing ones being abused.

### One request per root, not one per node

Mastodon's context endpoint returns the **entire descendant subtree** in one response,
bounded by the origin's own `MAX_DESCENDANTS` and depth limits. So the walk is one HTTP
call per root and the tree-building is local arithmetic over `in_reply_to_id`. Two
thousand roots is two thousand requests — about 35 minutes at one per second, which is
just under Mastodon's default 300-per-five-minutes.

The instance asked is always his own. `objects.ap_id` for his toots is
`https://skvip.lol/users/markus/statuses/<id>`, and that trailing id is only valid there;
his instance is also the only one holding the whole thread rather than the fragment that
happened to federate.

### Anonymous first, and that is the privacy mechanism

The context is read **without** the token. An anonymous context can only ever contain
public and unlisted statuses, so a followers-only reply is never handed to this process:
there is nothing to filter, nothing to log by accident, nothing sitting in a response
body. `MASTODON_ACCESS_TOKEN` is used only if the instance refuses anonymous reads
outright, and the visibility filter runs either way. Like `fetchRestLeg` in
`fetch-engagement.ts`, the token is gated on exact origin equality with `OWNER_INSTANCE`.

### The root is a node, at depth 0

So the tree is renderable from one query and an edge list needs no synthetic vertex.
Every `external_*` figure excludes his own nodes, the root included — which is what makes
a thread he is only talking to himself in score **zero** external replies rather than
one, and drop out of the leaderboard entirely.

### An orphan takes its subtree with it

A reply under a dropped reply is dropped, never promoted to depth 1. Re-parenting would
invent an exchange that never happened, and — worse — it would disclose the shape of the
hidden reply: how many answers it drew is exactly what not storing it was meant to
protect.

### A walk replaces the node set; nothing is tombstoned

`DELETE … WHERE root_ap_id = $1` then bulk insert, in one transaction. A reply deleted at
its origin is absent from the next response and therefore simply gone. There is no
`deleted_at` on a node to reason about, and no row that quietly remembers a post someone
removed.

The corollary is that **a failed fetch must never reach that path.** A 404 or a timeout
is not a thread emptying, so `recordWalkFailure` writes the error and the attempt count
and leaves the stored tree exactly as it was. That makes a persistent failure invisible
unless it is listed, so `/admin/threads` lists it (record 0039's lesson).

### Seven days settles a thread, and only a backfill reopens it

The daily pass takes roots never walked plus roots whose newest known node is under
`THREAD_SETTLED_DAYS` old. Everything else is skipped, which is the only reason a daily
job is not a nightly repeat of the backfill.

`newest_node_at` **falls back to the root's own `published_at`** when the tree has no
replies. Without that fallback a brand-new toot would read as settled the moment it was
first walked — during precisely the week its replies arrive.

A settled thread that somehow gains a reply waits for the next backfill. That is a
deliberate trade: the alternative is asking about two thousand quiet threads every night
to catch the rare late reply.

### The tools read the store; the walk is a job

`get_thread_leaderboard` ranks on `external_node_count` by default and also on
`max_depth` and `external_participant_count`, and reports the walker's own state
alongside — an empty leaderboard because nothing has been walked yet and one because
nothing drew a reply look identical otherwise (record 0015's property).
`get_thread_tree` returns nodes and edges as separate arrays, which is what a graph
layout takes. The root's own text is joined live from `objects`; there is no reply text
to join.

Both are on the REST API as well, `publicOnly`-wrapped. Markus was asked and chose it,
with the consequence stated: `publicOnly` filters *root visibility*, not participant
handles, so `/api/v1/thread-tree` does serve `@user@host` for external repliers. The
surface is `REST_API_KEY`-gated rather than world-readable, and the handles it serves are
already public on the posts themselves — but it is a wider audience than MCP, and that is
the choice being recorded.

## Alternatives considered

**Store the replies and redact them later.** The simplest thing that renders a thread,
and the one thing that was ruled out from the start: text in the database is text in the
backups, in the query log and in the next feature that joins against it. Storing only
what the graph needs is the only version where the promise is checkable.

**Tombstone deleted replies.** Would let a tree show "someone deleted a reply here",
which is information about a person's decision to withdraw something. Replacing the set
means the record of what they removed is removed too.

**Walk node by node.** One request per reply, ~40,000 requests instead of ~2,000, for
data the context endpoint already returns whole. The only reason to want it would be
depth beyond Mastodon's own limit, which is 20 and has never been reached here.

**Skip defederated hosts by reading the instance blocklist.** Unnecessary as the primary
mechanism: the context comes from his own instance, so a host it has defederated never
appears in the response at all. `THREAD_SKIP_HOSTS` exists as the explicit second lever,
for hosts his instance still federates with and he does not want in his archive.

**Rank on a quality or sentiment score.** Explicitly out of scope. The tools count nodes,
depth and people; who "won" an argument is not a thing this archive gets an opinion about.

## Consequences

- Threads rooted in someone else's toot are not walked, including ones he replied into.
  The roots are his own originals, so the store never contains a conversation he did not
  start.
- Nothing before the archive's start (July 2023) is reconstructable, and the walk does
  not try.
- `max_depth` is bounded by the origin's own context limits. A thread deeper than
  Mastodon's `DESCENDANTS_DEPTH` is stored truncated rather than wrong, and the CHECK on
  `depth` (≤ 1000) is a schema guard, not the real ceiling.
- The leaderboard inner-joins `objects`, so a root deleted or hidden after being walked
  drops out rather than appearing as a row with no text. Its nodes stay until the row is
  removed.
- Criterion 6 exists so a renderer can be added later without touching the schema. The
  data and the two tools ship first; the visualisation is out of scope.
