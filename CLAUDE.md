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
