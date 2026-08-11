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

## Gigs

Concert attendances federate from **Gigowl** (`samklang.msge.no`, software name `samklang`)
as ordinary public Notes whose `tag` carries a `Link` named `Konsert` pointing at the
concert. That link is the discriminator; the concert URL dereferences as an AS2 `Event`
and is the join key. `get_gigs` / `get_gig_details` / `get_gig_stats`, `/api/v1/gigs`,
**Admin → Media → Gigs**, and its own lane on the public stream. See ADR 0037.

Two rules not to "simplify" back:

- **`gig_date` is the night of the gig; `published_at` is when it was logged.** The origin
  stamps a Note with the attendance's `updatedAt`, so a decade of concerts imported in one
  afternoon all publish that afternoon. Every gig surface sorts on `gig_date`.
- **Never fetch the origin with an `Accept` header mentioning `text/html`.** Gigowl answers
  HTML for anything ambiguous, so a browser-ish header silently returns a web page and
  looks exactly like a missing ActivityPub representation.

## Stack

Hono + TypeScript, PostgreSQL. The `db` service (postgres) is internal-only and not exposed to the host. The `app` service exposes port 3000 to the host so central Caddy can reach it.

## Environment

Requires `.env` on the server at `/srv/bot/.env`.
Never commit `.env` to git.
