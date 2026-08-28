# activitypub-mcp

## Deployment environment

This service runs on a shared Hetzner VPS (SSH alias `msge`, IP `157.180.66.111`).

| Key | Value |
|-----|-------|
| Server path | `/srv/bot` |
| Domain | `bot.skvip.lol` |
| Host port | `3000` (must be `0.0.0.0:3000`, not `127.0.0.1:3000`) |
| Runtime | Docker Compose |
| Deploy | `make deploy` (pulls latest code, rebuilds app image, restarts) |

## Central ingress — do not manage Caddy here

TLS and routing are handled centrally in **`github.com/mmsge/hetzner-server`** — not in this repo.

- The Caddyfile block for this service lives at `hetzner-server/Caddyfile`
- Service documentation lives at `hetzner-server/services/activitypub-mcp.md`
- To change routing or the domain, edit that repo and run `make reload` on the server

This repo previously had its own bundled Caddy service in `docker-compose.yml` — that was removed (PRs #8/#9) because central Caddy now handles TLS. Do not add a Caddy service back to this repo.

## Other services on the same server

| Service | Domain | Host port |
|---------|--------|-----------|
| skjenelangs.no | skjenelangs.msge.no | 4001 |
| markescence | markescence.msge.no | 4002 |
| daggerheart (river-sky) | rpg.msge.no | 4000 |
| **activitypub-mcp** | bot.skvip.lol | **3000** |
| **meg (offentleg straum)** | meg.msge.no | **3000** (same container) |

**Port 3000 is reserved for this service.** Do not change it without updating the Caddyfile in `hetzner-server`.

## Two domains, one container

This app serves **two sites on port 3000**, routed on the `Host` header by a
dispatcher at `serve()` in `src/index.ts`:

| Host | What it is |
|------|------------|
| `bot.skvip.lol` | The ActivityPub actor, the admin UI, MCP and the REST API |
| `meg.msge.no` | A public, unauthenticated stream of Markus' own posts |

They are two separate Hono apps, not route groups — so the actor and the admin UI
are *not mounted* on the public host, and a route added to the bot app cannot leak
onto it. `STREAM_DOMAIN` unset disables the stream entirely. Caddy points both
domains at `172.18.0.1:3000`. See ADR 0018.

## Breakout alerts

When one of Markus' posts beats **his own baseline** (p90 → p99 → personal best of that
account's own recent posts), an ntfy push goes to `n.msge.no` on its own topic
(`NTFY_TOPIC_BREAKOUT`, default `tut-treff`), plus a low-priority digest each evening.
`BREAKOUT_ENABLED` is **off by default** and the first run after arming is silent — it
records where every post already stands rather than replaying the archive. Inspect at
`/admin/breakouts` or via `get_post_breakouts`. See ADR 0036.

The one rule not to "simplify" back: every score is the post's **peak** across its whole
snapshot history, never the latest snapshot. Engagement counts go down, and reading the
latest one would let an un-favourite lower the record every other post is measured against.

## Scrobble races

Two things in the listening history race head-to-head, and a **side is an entity**: an
artist, an album or a track. Races live in **`races.json` at the repo root** (path
overridable with `RACES_CONFIG_PATH`), several run at once, and each carries its own ntfy
`topic`, `milestones`, `endgame_gap` and `nowplaying_gap`. `list_scrobble_races` /
`get_scrobble_race`, `/api/v1/scrobble-races` and `/api/v1/scrobble-race`. See ADR 0051
and 0052.

Rules not to "simplify" back:

- **`albums` and `tracks` are LISTS.** Last.fm files a single under its own album name, so
  `The Good Witch` and `Lost The Breakup` are separate rows for one campaign. A list folds
  them together, and `album_name IN (…)` counts each row once — a sum of per-name counts
  gives the same answer today and double counts the day two names overlap.
- **Matching is EXACT**, unlike `get_scrobble_stats`' substring `ilike`. A countdown that
  reaches zero must not have its finish line moved by a "feat. …" credit, and `lower()`
  would seq-scan the whole table on every 60-second sync tick.
- **The state table keeps its dedupe columns.** `leader_plays`/`challenger_plays`,
  `last_announced_gap` and `last_nowplaying_*` are what keep the watcher quiet;
  `endgame_armed_at` is a timestamp **latch**, not a boolean level (ADR 0022).
- **`overtaken_at` never re-fires and never clears.** A challenger who falls back behind
  after winning leaves the race resolved. A race added *after* its crossover has that
  timestamp reconstructed from the stored plays, not read off the latest one.
- **`races.json` must be in the image** — `Dockerfile` copies it explicitly. Without that
  line the service boots with no races, which looks exactly like the feature working.
- `RACE_LEADER_ARTIST` / `RACE_CHALLENGER_ARTIST` are **deprecated** and honoured for one
  release by the tool only; the notifier reads `races.json`. Remove them from
  `/srv/bot/.env`.

## Convergence watcher

Two monotonic counters over the same archive — `total_scrobbles` and `total_km` — and an
ntfy push the moment they **meet** (priority `high`) or **swap places** (priority
`default`), on its own topic (`NTFY_TOPIC_CONVERGENCE`, default `konvergens`).
`CONVERGENCE_ENABLED` is **on** by default. They have met once, 2020-01-11 at 3,298 each,
and that state held three minutes and ten seconds. Inspect at `get_convergence` or
`/api/v1/convergence`. See ADR 0056.

Rules not to "simplify" back:

- **A leg counts from when it DEPARTED, not from `status = 'Completed'`.** Viaduct
  freezes `Planned` on any row imported once and never re-exported — the ADR 0031 trap
  that hid 13 journeys from the public stream. Two legs today (397 km) are departed and
  still `Planned`, and at ~35 km/day that is a week and a half of difference in when the
  counters next meet. `departure_at <= now()` is what "Completed, or departed" means.
- **The dedupe key is `(kind, occurred_at)`, never a row id.** A re-imported leg gets a
  new uuid for the same journey (identity is `from/to/departure_at`, ADR 0048) and the
  post-import walk re-derives every crossing from scratch. Keyed on an id, both would
  read as new and push again.
- **`occurred_at` is the cause's own instant, never detection time.** A backfilled export
  puts a crossing in the past; `historical` is what makes the copy past tense.
- **The watermark is valid for scrobbles and NOT for legs.** `sync-scrobbles` cursors on
  `max(uts) + 1`, so a play can never arrive behind it. An import can insert, correct or
  delete a leg at any date, which shifts the running difference for everything after —
  so the import and prune paths call `runConvergenceWatch({ recompute: true })` and walk
  the whole archive. The tick's fast path exists only because that hazard cannot reach it.
- **A scrobble can never flip the sign without landing on zero.** It steps by one, so it
  always visits `d = 0`. Every crossover is therefore a kilometre lump, and *leaving* an
  equality window is the resolution of a crossing already announced — not a new one.
- **The row is written before the push and stamped after it.** `notified_at` makes the
  table a retry queue: a failed publish leaves the crossing owed and does not advance the
  watermark. The watcher refuses to run without `NTFY_PASSWORD` for the same reason — the
  row is its own "already told you" mark, so anything recorded while unarmed is buried.
- **It evaluates on every tick, not only when the sync wrote rows.** A train departing
  moves the other counter on a clock, with no ingest to react to.
- **Several new crossings collapse into ONE push.** Only a backfill produces more than
  one; announcing each would be a burst about a single edited CSV row.

## Gigs

Concert attendances federate from **Gigowl** (`@markus@gigowl.social`, software name
`samklang`) as ordinary public Notes whose `tag` carries a `Link` named `Konsert` pointing at
the concert. That link is the discriminator; the concert URL dereferences as an AS2 `Event`
and is the join key. `get_gigs` / `get_gig_details` / `get_gig_stats`, `/api/v1/gigs`,
**Admin → Media → Gigs**, and its own lane on the public stream. See ADR 0037.

The origin used to live at `samklang.msge.no` with Nynorsk paths (`/konsert/`, `/oppmote/`,
`/brukar/`) and moved, in one window, to `gigowl.social` with English ones (`/gig/`,
`/attendance/`, `/user/`) — Gigowl's ADR 0029 and 0030, ours 0038. Two consequences worth
knowing before touching anything gig-shaped:

- **`canonicalGigUri` in `src/lib/gig-attendance.ts` rebases every Gigowl URI on the way in.**
  A stored `raw` payload is kept exactly as delivered, so replaying one is what would
  otherwise reopen the old keys. `npm run rebase-gig-origin` moved the stored rows once.
- **`https://samklang.msge.no/ns#` is NOT the old domain — it is the JSON-LD vocabulary**,
  frozen by the origin and shared by every instance of the software. Nothing may move it;
  the RSVP status tags point at it.

Two more rules not to "simplify" back:

- **`gig_date` is the night of the gig; `published_at` is when it was logged.** The origin
  stamps a Note with the attendance's `updatedAt`, so a decade of concerts imported in one
  afternoon all publish that afternoon. Every gig surface sorts on `gig_date`.
- **Never fetch the origin with an `Accept` header mentioning `text/html`.** Gigowl answers
  HTML for anything ambiguous, so a browser-ish header silently returns a web page and
  looks exactly like a missing ActivityPub representation.

## Thread shape

Every conversation rooted in one of Markus' own toots is walked and stored as a **tree of
ids and links, never of words**: status id, origin, permalink, parent, depth, publish time,
`@user@host` handle, mine-or-theirs. `get_thread_leaderboard` / `get_thread_tree`,
`/api/v1/thread-leaderboard` and `/api/v1/thread-tree`, and **Admin → Threads**. The daily
pass is `THREAD_WALK_INTERVAL_HOURS` (0 disables); the full pass is
`npm run walk-threads -- --backfill --max-requests=2500`. See ADR 0057.

`replies_count` counts DIRECT children only, which is the whole reason this exists — four
replies that each spawned an argument beat thirteen flat ones on tree size, and the REST
count cannot see it.

Rules not to "simplify" back:

- **No column anywhere can hold reply content, and that is enforced twice.** Every text
  column carries a CHECK constraining it to a handle, a hostname, an id or an https URL —
  `handle` accepts `@user@host` and nothing else — and `src/db/thread-schema.test.ts` pins
  the column set so a new column fails CI. Either layer alone is a convention.
- **The root is a node, at depth 0, and it is his.** So the tree renders from one query.
  Every `external_*` figure excludes it, which is what makes a thread he is only talking to
  himself in score zero rather than one and drop off the leaderboard.
- **An orphan takes its subtree with it.** A reply under a followers-only reply is dropped,
  never promoted to depth 1. Re-parenting would invent an exchange *and* disclose how many
  answers the hidden reply drew.
- **A walk REPLACES the node set in one transaction, and a failed fetch never reaches it.**
  That is how a deleted reply disappears with nothing tombstoned — and why a 404 or a
  timeout writes `walk_error` and leaves the stored tree alone. A failure is therefore
  invisible unless listed, so `/admin/threads` lists it.
- **`newest_node_at` falls back to the ROOT's own `published_at`.** Without it a brand-new
  toot reads as settled the moment it is first walked, during exactly the week its replies
  arrive. Settled (newest node ≥ `THREAD_SETTLED_DAYS`) is skipped by the daily pass; only a
  backfill revisits it.
- **The context is read UNAUTHENTICATED first.** An anonymous context can only contain
  public and unlisted statuses, so a followers-only reply never reaches this process at all.
  The token is a fallback for an instance that refuses anonymous reads, not the default.
- **One request per ROOT, not per node.** Mastodon's context endpoint returns the whole
  descendant subtree; walking node by node would be ~40,000 requests for data one call
  already gives.
- **"No actors" is TWO conditions and they are reported separately.** Nothing configured
  (set `THREAD_ACTORS`/`OWNER_ACTOR`) and configured-but-matched-nothing (the handle is
  not spelled the way the archive spells it) have different fixes, and both print the
  stored handles so neither needs a psql session. Unset falls back to accepted follows
  running Mastodon, so a deploy that configures nothing still walks.

## Webhooks out

This service wakes two others on the box when data lands, so neither has to wait out
its own timer. Both are **fire-and-forget optimisations**: every receiver still
re-reads on its own schedule, so a dropped, failed or unconfigured notification costs
latency and nothing else.

| Receiver | Module | Config pair | Fired by |
|----------|--------|-------------|----------|
| `bartenderen` (`/webhook/tog`) | `src/lib/trip-webhook.ts` | `BARTENDEREN_WEBHOOK_*` | the train-trip import and prune |
| `msge.no` (`/webhook/:emne`) | `src/lib/msge-webhook.ts` | `MSGE_WEBHOOK_*` | trip + YouTube imports, the trip **prune**, the garden sync, and every ingested object |

The three rules live once, in **`src/lib/webhook-post.ts`**: never throw (a failed
notification must not fail the import that triggered it), never retry (every receiver
already re-reads on a timer, and a retry loop here is a second worse implementation
of it), and never stay quiet about a failure (hetzner-server ADR 0011 — weeks of
silently-401ing ntfy pushes behind `curl -sf … || true`). ADR 0053 predicted a second
consumer would want its own config pair and its own call rather than a fan-out, and
that held — what it did not anticipate is that those three are **transport, not
policy**. ADR 0055 records the split.

Rules not to "simplify" back:

- **Scrobbles are deliberately NOT notified.** Both sides tick at 60 s, so the saving
  is under 30 seconds — against a POST every minute forever, and a permanently
  occupied rate-limit slot on the receiver. ADR 0053's value was collapsing a
  four-hour worst case; here the worst case is one minute.
- **`ingestObject` is debounced, and the debounce has a CEILING.** It fires once per
  object and a NeoDB repair or outbox re-crawl pushes hundreds through in seconds. A
  trailing debounce with no ceiling is reset by every new object, so a long backfill
  would send *nothing at all* — `MAX_DELAY_MS` is not optional. The timer is
  `unref()`d, or a pending debounce holds a short-lived script (and vitest) open.
- **The topic is the upstream event, not the page.** `tog`, `tuben`, `bok`, `film`,
  `tut`, `bilete`, `tankehav`, `lyttar`, `poppis`. Which pollers each wakes is
  msge.no's business, declared in its own registry, so it can add a page without a
  change here.
- **A NeoDB *book* mark is `bok`, not `film`.** msge.no's `/film` is built from
  `/watched`, which is film and TV; routing a book there wakes a poller that will
  never show it. `isNeodbBookUrl` is already imported in `create.ts` for enrichment
  routing, so the check is free.
- **`msge.no` must be dialled on `172.18.0.1:4003`.** Its receiver refuses anything
  carrying `X-Forwarded-*`, so going through `https://msge.no` answers 404 by design.
- **Gig attendances map to `tut`** until msge.no grows a gig page — inventing a topic
  nothing listens to would be a wake that always 400s.

## Stack

Hono + TypeScript, PostgreSQL. The `db` service (postgres) is internal-only and not exposed to the host. The `app` service exposes port 3000 to the host so central Caddy can reach it.

## Environment

Requires `.env` on the server at `/srv/bot/.env`.
Never commit `.env` to git.
