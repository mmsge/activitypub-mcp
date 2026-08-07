# 0032 — One image, two hosts: `/version` names the deployable, and the ops contract is mounted on both apps

**Status:** Accepted
**Date:** 2026-08-07
**Topics:** health, versioning, deploy, observability, ops, privacy, hono
**Contributors:** Claude (agent decision — no human input on the technical choice)

## Context

naustet-server [ADR 0022](https://github.com/mmsge/naustet-server/blob/hovud/docs/decision-records/0022-version-and-health-endpoints.md)
gives every service on the box three fixed paths: `/healthz` (liveness), `/version`
(which commit is *actually* running) and `/health` (readiness, with per-dependency
checks). The rollout assumes the ordinary shape — one repo, one image, one domain,
one slug.

This service is the exception. Since [0018](0018-publish-the-archive-as-a-public-stream.md)
one container serves **two sites on one port**: `bot.skvip.lol` (the ActivityPub
actor, the admin UI, the MCP endpoint) and `meg.msge.no` (the public stream), as two
separate Hono apps behind a `Host`-header dispatcher at `serve()`. The box's service
registry lists them as two rows.

So the contract raises two questions it does not answer:

1. **Which app serves the three paths?** They are two apps, not two route groups.
   Mounting the router on one of them leaves the other 404ing — and `streamApp` has
   a `notFound()` handler that answers with a rendered HTML page, which the box's
   probe reads as *endpoint absent*, not as *endpoint broken*.
2. **What does `service` say?** There is one image and one commit, but two names.

And one more, specific to what this service is: `/health` is **public**, and this app
federates. Naming an upstream is normally encouraged by the contract — but the
upstreams here are the accounts Markus follows.

## Decision

### The same router object is mounted on both apps

`src/ops/router.ts` exports one `Hono` instance. `src/index.ts` mounts it on the bot
app and `src/stream/router.tsx` mounts it on the stream app, both **first**, ahead of
every other route and of `streamApp.notFound()`.

Not two copies, not a shared factory called twice: the same object, so the two hosts
cannot drift into answering differently about one image.

Three paths have to work, and they are genuinely distinct:

| Request | Dispatcher sends it to | Why it matters |
|---|---|---|
| `Host: bot.skvip.lol` | bot app | the actor/admin/MCP host |
| `Host: meg.msge.no` | stream app | the public stream host |
| **no `Host` at all** | bot app (the fall-through) | this is the container healthcheck's own request, and Caddy's `172.18.0.1:3000` probe |

The fall-through was already load-bearing before this record ([0018](0018-publish-the-archive-as-a-public-stream.md)
says so), and `STREAM_DOMAIN=` unset makes *every* request take it. The ops endpoints
therefore work with the stream switched off, which is the state the feature ships in.

### `service` is `bot` on both hosts, unconditionally

`/version` describes the **image**, and there is exactly one: one commit, one
`/srv/bot`, one Compose project `bot`, one container `bot-app-1`. `meg` is a domain,
not a deployable — it has no directory, no project and no port of its own; deploying
`/srv/bot` deploys it, and `STREAM_DOMAIN=` takes it down. The box's MCP attributes
containers by slug prefix, and `bot` is the name that resolves to a running one.

**The alternative — vary `service` by `Host` — was rejected**, on two grounds:

- It would make `/version` echo a request-derived value back to the caller.
  The contract's deny list names `Host` explicitly, and for a good reason: an
  endpoint whose answer depends on how you asked cannot be used to compare two
  answers.
- It would report two identities for one artifact. `/version` exists to stop a
  service claiming to be something it isn't; inventing a second name for the same
  image is that same lie pointed the other way.

An agent that asks `meg.msge.no/version` and gets `service: "bot"` has learned
something true and useful — that these two hosts are one deployable.

### The `checks[]` names are a closed, user-independent set

`database`, `queue`, `scheduler`. **No fediverse instance is ever named**, and no
upstream check exists at all.

This is the `lesesalen` trap (its ADR 0015), and this repo sits deeper in it. The
things this app talks to are, almost without exception, a property of *whose account
it is*: the actors in `FOLLOW_ACTORS`, the BookWyrm instances in `BOOKWYRM_ACTORS`,
the personal inbox, and every inbox URL in the delivery queue. A public check named
`upstream:<instance>` carrying an age-since-last-success would publish who the
account follows and where it reads — user data wearing an upstream's clothes.

So the `queue` check reports **depth** and the **age of the oldest overdue item**,
aggregated across every destination at once. Both are non-identifying cardinals,
which the contract's allowlist permits; neither can be resolved back to an inbox, a
host or an actor.

A few upstreams *are* fixed config rather than user choice (Last.fm, NeoDB), and the
contract would allow naming those. Declined anyway: mixing a named check in among the
aggregate ones invites the next contributor to add `upstream:<bookwyrm-instance>` by
symmetry. One rule for the whole file is easier to keep true than a per-upstream
judgement call.

### The substantive check is the one that catches a silent death

`/health` must carry at least one check that would actually catch a real failure.
Here that is **the scheduler heartbeat** (`src/lib/heartbeat.ts`), beaten at the top
of the 30-second delivery interval — *before* the work runs, so a throwing delivery
does not read as a dead timer.

Every ingest in this app is a `setInterval` in `src/jobs/scheduler.ts`. If they stop,
nothing else notices: the HTTP surface keeps answering, the database keeps
responding, the container stays "healthy", and posts simply stop being delivered
while scrobbles stop arriving. That is the failure this endpoint is for. The queue's
overdue age catches its sibling — deliveries queued and never drained.

Errors are classified, never stringified: a failed query's message carries the
connection string.

## Consequences

- The `meg` row in the box registry reports `service: "bot"` and the same commit as
  the `bot` row. That is correct — there is one image — but a reader expecting the
  slug to match the row needs this record to know why.
- The scheduler heartbeat is in-process and resets on restart, hence the 120-second
  grace before a process that has never beaten counts against health. It reports on
  *this* container's timers, which is the point; a stored timestamp would also be
  satisfied by some other process having run.
- `SLUG` is duplicated in `scripts/generate-build-info.sh` and `src/ops/build-info.ts`
  and must stay in step. If the stream is ever split into its own container with its
  own `/srv` directory, both change there and this record is superseded.
- `/version` is the only endpoint on either host whose body is byte-identical across
  the two — deliberately. A test asserts it.
