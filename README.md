# ActivityPub MCP Server

[![deployed](https://img.shields.io/endpoint?url=https://utrulla.msge.no/badge/mmsge/activitypub-mcp)](https://bot.skvip.lol)

A personal ActivityPub actor that follows other accounts, archives their posts in PostgreSQL, and exposes an MCP server so AI agents can query the data.

Works with **Mastodon**, **BookWyrm**, **Pixelfed**, and **Loops**.

## How it works

- The server has its own ActivityPub identity (an actor with a public/private RSA keypair).
- You configure which accounts to follow via an environment variable. On startup, the server sends Follow requests to any account not already followed.
- Incoming activities (posts, boosts, book updates, etc.) are verified, stored, and parsed. BookWyrm reading data gets its own structured table.
- The server **auto-rejects all incoming Follow requests** — it is a read-only bot, not a social participant.
- The actor publishes an informative profile — bot type, avatar, header and metadata fields — plus a human-readable page at `/@<username>` that spells out what it archives and what it keeps about everyone else (see [Actor profile](#actor-profile)).
- It posts about **itself and nothing else**: a pinned intro and a periodic status note giving the size of its own archive. The archive it collects stays private (see [What the bot posts](#what-the-bot-posts)).
- An admin UI at `/admin` lets you review stored data and inspect every HTTP request the server has handled, including signature validity.
- An MCP server at `/mcp` lets AI agents answer questions like "What did this user post today?" or "What book is this user currently reading?"
- A read-only **REST API** at `/api/v1` exposes the archive to non-MCP clients (scripts, cron jobs, dashboards), gated by an API key. It serves **public posts only** — the MCP tools see followers-only posts too, because that is you reading your own archive; REST is what other sites republish (see [REST API](#rest-api)).

---

## Preconditions

Before you start, you need:

- A **Hetzner Cloud account** with a VPS running **Ubuntu 24.04**. A CX22 (2 vCPU, 4 GB RAM) is more than sufficient.
- A **domain name** pointed at the VPS's public IP address with an A record. The server must be reachable over HTTPS — this is required by the ActivityPub protocol.
- SSH access to the VPS as root or a user with sudo.
- **Docker** and **Docker Compose** installed on the VPS (see step 1 below).
- **Node.js 18+** on your local machine (only needed to generate the admin password hash).
- The source code on your VPS (clone this repository).

---

## Deployment

### 1. Prepare the VPS

SSH into your Hetzner VPS and install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

Verify it works:

```bash
docker --version
docker compose version
```

### 2. Clone the repository

```bash
git clone <your-repo-url> /srv/bot
cd /srv/bot
```

### 3. Generate the admin password hash

Run this on your **local machine** (requires Node.js):

```bash
node -e "require('bcryptjs').hash('yourpassword', 12, (_, h) => console.log(h))" 2>/dev/null || \
  npx -y bcryptjs-cli hash yourpassword
```

Or install the project dependencies locally first and use the included script:

```bash
npm install
npm run create-admin yourpassword
```

Copy the output line that looks like `$2b$12$...` — you will need it in the next step.

### 4. Create the `.env` file

On the VPS, copy the example file and fill in the values:

```bash
cp .env.example .env
nano .env
```

Here is what each variable means:

| Variable | Required | Description |
|---|---|---|
| `APP_DOMAIN` | Yes | Your domain name, e.g. `bot.example.com` |
| `APP_USERNAME` | Yes | The ActivityPub username, e.g. `bot` — your actor will be `@bot@bot.example.com` |
| `APP_DISPLAY_NAME` | No | Human-readable name shown on the actor profile |
| `OWNER_ACTOR` | No | Your own fediverse handle (`@you@example.social`) or actor URL. Credited as the operator on the actor profile, and used as the default scope for the hashtag-analytics tools. |
| `ACTOR_PUBLISHED` | No | Date this actor went live (`YYYY-MM-DD`), published as its join date. Default `2026-05-02`. |
| `ACTIVITY_LOG_RETENTION_DAYS` | No | How long request-log rows are kept. Default `30`; `0` keeps them forever. See [Actor profile](#actor-profile). |
| `STATUS_NOTE_INTERVAL_HOURS` | No | Floor between the status notes the bot publishes about its own archive. Default `168` (weekly); `0` publishes only the pinned intro. See [What the bot posts](#what-the-bot-posts). |
| `DB_PASSWORD` | Yes | Password for the PostgreSQL database. Choose something strong. |
| `FOLLOW_ACTORS` | Yes | Comma-separated list of handles to follow (see below) |
| `ADMIN_PASSWORD_HASH` | Yes | The bcrypt hash you generated in step 3 |
| `SESSION_SECRET` | Yes | A random 32-byte hex string (generate with the command below) |
| `REST_API_KEY` | No | Shared secret for header-based access. Required to enable the read-only REST API at `/api/v1` (blank ⇒ `503`). Also accepted as a static-header credential for `/mcp` (the CLI/Desktop path); blank just disables that path — `/mcp` stays protected by OAuth. Generate like `SESSION_SECRET`. |
| `LASTFM_API_KEY` | No | Last.fm API key ([create one](https://www.last.fm/api/account/create)). Enables scrobble ingestion. |
| `LASTFM_USERNAME` | No | The Last.fm username whose scrobbles are ingested. Required alongside `LASTFM_API_KEY`. |
| `LASTFM_SYNC_INTERVAL_SECONDS` | No | How often to poll Last.fm for new scrobbles, in seconds. Default `60`, minimum `15`. |
| `LINKEDIN_DMA_TOKEN` | No | Access token for LinkedIn's Member Data Portability (Member) API ([how to mint one](#linkedin-posts-and-performance)). Enables the LinkedIn post poller; blank disables it. The `.xlsx` metrics import works without it. |
| `LINKEDIN_SYNC_INTERVAL_HOURS` | No | How often to re-crawl the LinkedIn snapshot, in hours. Default `168` (weekly), minimum `1`. |
| `BREAKOUT_ENABLED` | No | Push an ntfy alert when a post beats your own baseline. **Off by default** — deploy, check `/admin/breakouts`, then arm. See [When a post does well](#when-a-post-does-well). |
| `NTFY_TOPIC_BREAKOUT` | No | ntfy topic for those alerts. Default `tut-treff` — its own topic so it can be muted separately from the scrobble race. |
| `BREAKOUT_WEIGHT_FAVOURITES` / `_REBLOGS` / `_REPLIES` | No | Score weights. Default `1` / `3` / `2`. Changing one re-scores the whole archive (handled as a silent re-seed). |
| `BREAKOUT_BASELINE_DAYS` | No | Rolling window the p90/p99 bar is computed over. Default `90`, minimum `7`. The record rung is not windowed. |
| `BREAKOUT_CANDIDATE_DAYS` | No | How far back the hourly pass still considers a post. Default `30`. |
| `BREAKOUT_MIN_POSTS` | No | Refuse to arm an account with fewer scored posts in the window. Default `20`. |
| `BREAKOUT_MIN_SCORE` | No | Absolute floor every rung must clear, whatever the percentile says. Default `10`. |
| `BREAKOUT_OBJECT_TYPES` | No | Which object types count. Default is the sampler's list minus `GeneratedNote`. |
| `BREAKOUT_INCLUDE_REPLIES` | No | Include your replies in the bar and as candidates. Off by default. |
| `BREAKOUT_ACTORS` | No | Accounts to watch. Blank ⇒ every accepted follow. |
| `BREAKOUT_FAST_LANE_MINUTES` / `_HOURS` / `_MAX_POSTS` | No | The fast lane over young posts — the only part that spends remote API calls. Default `10` min / `24` h / `10` posts; `0` minutes disables it. |
| `BREAKOUT_DIGEST_HOUR` | No | Europe/Oslo hour for the daily digest. Default `21`; `-1` disables. A quiet day sends nothing. |
| `LOG_LEVEL` | No | `info` is fine for production. Use `debug` to see more. |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Example `.env`:**

```env
APP_DOMAIN=bot.example.com
APP_USERNAME=bot
APP_DISPLAY_NAME=My Reading Bot

DB_PASSWORD=a-very-strong-database-password

FOLLOW_ACTORS=@alice@mastodon.social,@reader@bookwyrm.social,@photos@pixelfed.social

ADMIN_PASSWORD_HASH=$2b$12$...paste-your-hash-here...

SESSION_SECRET=a1b2c3d4e5f6...64-hex-characters...

LOG_LEVEL=info
NODE_ENV=production
```

The `DATABASE_URL` is constructed automatically from `DB_PASSWORD` inside `docker-compose.yml` — you do not need to set it manually.

### 5. Configure TLS (external Caddy)

TLS termination is handled by a **central Caddy instance** running outside this project (e.g. `hetzner-server/Caddyfile`). The app binds only to `127.0.0.1:3000` and is not reachable directly from the internet.

Add a reverse-proxy block for your domain to that central Caddyfile:

```
bot.example.com {
    reverse_proxy 127.0.0.1:3000

    encode gzip

    log {
        output stdout
        format json
    }

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

A starting-point template is kept at [`docs/Caddyfile.example`](docs/Caddyfile.example) for reference.

### 6. Start the server

```bash
docker compose up -d --build
```

This will:
1. Build the application image
2. Start PostgreSQL and wait until it is healthy
3. Run database migrations automatically
4. Start the application (listening on `127.0.0.1:3000`)

Check that everything is running:

```bash
docker compose ps
docker compose logs -f app
```

The first startup takes about 30 seconds. You should see lines like:

```
Server started on port 3000
Actor: https://bot.example.com/actor
Admin: http://localhost:3000/admin
MCP:   https://bot.example.com/mcp
REST:  https://bot.example.com/api/v1
```

### 7. Verify the actor is discoverable

From **any Mastodon instance**, search for your actor handle:

```
@bot@bot.example.com
```

It should appear as a profile, with the pinned intro note on it. If it does not, check `docker compose logs app` for errors and confirm your DNS record is pointing to the correct IP.

You can also check the discovery endpoints directly — all four must answer `200`:

```bash
curl -s https://bot.example.com/.well-known/nodeinfo
curl -s https://bot.example.com/.well-known/host-meta
curl -s 'https://bot.example.com/.well-known/webfinger?resource=acct:bot@bot.example.com'
curl -s -H 'Accept: application/activity+json' https://bot.example.com/actor/featured
```

### 8. Check that follows were sent

Open the admin UI at `https://bot.example.com/admin` and log in with the password you set. Go to **Follows** — you should see your configured accounts listed with status `pending`. Once the remote servers accept your Follow requests, the status changes to `accepted`.

This can take a few minutes to a few hours depending on the remote server.

---

## Managing which accounts to follow

Edit `FOLLOW_ACTORS` in `.env` and restart the app:

```bash
nano .env
docker compose restart app
```

On restart, the server compares the list against the database and sends Follow requests for any new handles. Handles already followed (pending or accepted) are left alone.

To follow accounts on different platforms, use their native handle format:

```env
FOLLOW_ACTORS=@alice@mastodon.social,@bob@bookwyrm.social,@carol@pixelfed.social,@dave@loop.me
```

---

## Actor profile

The actor presents itself as a bot rather than a person, and says plainly what it does and does not keep, so anyone who runs into it in their notifications can tell what it is without asking.

`GET /actor` is content-negotiated: fediverse servers get the ActivityPub actor document, browsers get a readable page. The same page is served at `/@<username>`, which is what the actor advertises as its `url`.

What the actor document publishes:

| Field | Value |
|---|---|
| `type` | `Service` — clients show a **bot** badge instead of presenting it as a person |
| `summary` | Three-sentence bio: who operates it, what it archives, what it keeps about you |
| `attachment` | Profile metadata rows (operator, what it stores about others, what it archives, link to the public following list) — capped at four, the most Mastodon renders |
| `icon` / `image` | Avatar and header PNGs, served from `/assets` with a content hash in the URL |
| `manuallyApprovesFollowers` | `true` — the closest standard signal to "never followable"; every Follow is auto-rejected |
| `published` | Join date, from `ACTOR_PUBLISHED` |
| `attributedTo` | The operator's actor, from `OWNER_ACTOR` |
| `discoverable` / `indexable` | `true` — without `indexable`, Mastodon 4.2+ keeps the profile out of search entirely |
| `featured` | The pinned-posts collection Mastodon fetches on every profile refresh |

### Being findable

An actor that resolves is not the same as an actor anyone can find. Four things carry that, beyond the actor document itself:

| Endpoint | Why it matters |
|---|---|
| `/.well-known/webfinger` | Resolves the handle. Accepts the `acct:` URI, the bare `user@domain` handle and the actor's URLs, case-insensitively — implementations ask in all of these forms |
| `/.well-known/host-meta` (and `.json`) | The pre-WebFinger hop. Friendica, GNU Social and several WebFinger clients fetch this first and give up on the account when it 404s |
| `/.well-known/nodeinfo` → `/nodeinfo/2.0`, `/nodeinfo/2.1` | Where the fediverse crawlers and instance-info lookups probe. The bare `/nodeinfo` path answers the same document |
| `/actor/featured` | Pinned posts. Fetched on every profile discovery and refresh, and rendered at the top of the profile — the one way a post of this bot's reaches someone else, since it has no followers |

`/actor` and `/@<username>` both send `Vary: Accept`, so a shared cache cannot hand a fediverse server the HTML page a browser asked for a moment earlier.

### What the bot posts

The bot publishes two kinds of note, both about itself and never about anyone else:

- **A pinned intro** explaining what it is, with links to the open following list and the profile page. Created on first start; reworded in place — never duplicated — when the configuration it quotes changes.
- **A periodic status** giving the size of the archive: how many accounts it follows, how many public posts it has archived, and the date of the oldest. Every figure is an aggregate over the operator's own accounts.

`STATUS_NOTE_INTERVAL_HOURS` (default 168, weekly) is the *floor* between status notes, not a guarantee of one: an unchanged status never reposts, and no status is published at all until there is something to report. Set it to `0` to publish only the pinned intro.

`GET /actor/outbox` serves these notes and nothing else — the archive of the followed accounts' posts is private and never appears there. Without `?page` it is the `OrderedCollection` with `totalItems`; with `?page=N` a page of 20, newest-first. Each note also has its own permalink at `/notes/<id>`, content-negotiated like the actor.

There are no followers to deliver to, so nothing is queued for delivery. The notes reach people through `featured`, the outbox, and the profile page. See [ADR 0014](docs/decision-records/0014-make-the-account-visible-over-activitypub.md).

### Keeping the privacy claim true

The profile tells strangers it stores nothing about them. Two mechanisms back that up, and both are worth knowing about before you change them:

- The inbox **discards activities from accounts the server does not follow** before storing them, so the archive only ever holds posts from the configured `FOLLOW_ACTORS`.
- The inbox **does** log every inbound request — headers plus the first 10 kB of body — before deciding whether to act on it, which is what makes federation debuggable. That log therefore contains traffic from people the bot does not follow, so it is pruned to `ACTIVITY_LOG_RETENTION_DAYS` (default 30) on startup and every six hours. Setting it to `0` disables pruning and makes the profile's claim untrue.

### Regenerating the profile images

The avatar and header are generated from code — no binary editing needed:

```bash
npm run generate:profile-images
```

This rewrites `src/assets/avatar.png` and `src/assets/header.png` from the shapes and palette in `scripts/generate-profile-images.ts`. The URLs the actor publishes carry a hash of the file contents, so remote instances pick up new artwork on their next actor refresh instead of keeping the old cached avatar forever.

---

## Offentleg straum (meg.msge.no)

A second, public site served by the **same container on the same port**, routed on
the `Host` header: `bot.skvip.lol` keeps the ActivityPub actor, the admin UI and
MCP, while `meg.msge.no` is a public page republishing Markus' own posts as one
event-ordered stream. See ADR [0018](docs/decision-records/0018-publish-the-archive-as-a-public-stream.md).

```sh
STREAM_DOMAIN=meg.msge.no
STREAM_SOURCES=@markus@skvip.lol|mastodon,@mvrkws@bookwyrm.social|bookwyrm,@markus@pixelfed.babb.no|pixelfed,@markus@loops.video|loops,@markus@minreol.dk|neodb,@markus@rullen.no|rullen,@markus@gigowl.social|samklang
STREAM_INCLUDE_UNLISTED=          # unset = unlisted posts stay withheld
STREAM_SCROBBLE_CUTOFF_MONTHS=12  # daily music digests only this far back
STREAM_CACHE_TTL_SECONDS=180
```

**`STREAM_DOMAIN` unset disables the whole thing** — no route answers, nothing is
published. That is the off-switch: it lets the code deploy and be verified before
anything becomes visible, and it takes the site down without touching Caddy.

### What it publishes

| Included | Excluded |
|---|---|
| Original posts from the accounts in `STREAM_SOURCES` | Replies to other people |
| Markus' own threads, grouped into one entry | Boosts, and anything by anyone else |
| BookWyrm starts, finishes, reviews and quotations | Bare ratings, automatic progress notes |
| NeoDB marks with a status | Wishlist marks ("want to watch") |
| Daily Last.fm digests, train trips, garden notes | Scrobbles older than the cutoff |
| Posts that were **public** at their origin | Unlisted, followers-only, direct — and anything whose visibility cannot be read |

Ordered by **when things happened**, not when they were posted: a film marked today
but watched in 2016 sits in 2016. Content warnings are honoured — the body and its
media collapse behind the warning, with no JavaScript.

**Garden notes and their dates.** Most markus.plus notes carry no date — 102 of 384
have a `dato`/`modified`/`anskaffet` frontmatter field and 282 do not, and there is
none to be found anywhere else in the Obsidian Publish cache. A note that reviews a
book carries `bookwyrm` (the Edition URL) instead, so its date is recovered from the
public BookWyrm reading events for that edition, stored in `derived_date` rather than
in `note_date`, and labelled as recovered on the page. Notes with neither are listed
by name under **"Utan dato"** at the foot of `/kjelde/hage` — outside the stream,
because a stream ordered by real dates must not contain invented ones. See ADR 0020.

**Images** are fetched by the app and served from its own origin at
`/bilete/<sig>/<url>`, so reading the page contacts one host rather than seven, and a
rotated CDN URL does not take the image with it. Signed (an unminted URL 404s), host
allowlisted (checked again on serve and after every redirect), no SVG, and never
resized — the box has two vCPUs. Bounded by `STREAM_IMAGE_CACHE_MB` (250 MB) with
least-recently-used eviction, in the `image_cache` volume. Set it to `0` and the page
goes back to hotlinking, and the colophon says so. See ADR 0021.

Routes: `/`, `/kjelde/<platform>`, `/type/<kind>`, `/emne/<tag>`, `/arkiv/YYYY/MM`,
`/feed.atom`, `/bilete/<sig>/<url>`, `/robots.txt`, `/sitemap.xml`.

### How to verify nothing private leaks

The visibility rule is the load-bearing part, and it is the one irreversible step —
a post that should not have been public is public the moment a crawler reads it. So
deploy with `STREAM_DOMAIN` **unset**, then:

1. Open **`/admin/visibility`**. Check the public counts per account look roughly
   right; open ten withheld rows and confirm each should be withheld; open ten
   publishable rows at their origin and confirm they really are public there.
2. Set `STREAM_DOMAIN` and `STREAM_SOURCES`, restart, and check from the box before
   DNS exists:

   ```sh
   curl -H 'Host: meg.msge.no' http://172.18.0.1:3000/ | head -50
   curl -sI -H 'Host: meg.msge.no' http://172.18.0.1:3000/actor    # must be 404
   curl -sI http://172.18.0.1:3000/actor                           # unchanged
   ```
3. After it is live:

   ```sh
   # a known followers-only post must be absent
   curl -s https://meg.msge.no/ | grep -c '<a distinctive phrase from it>'   # 0
   # hosts the page loads from — links are fine, these are what a reader fetches
   curl -s https://meg.msge.no/ | grep -oE 'src="https?://[a-z0-9.-]+' | sort -u
   ```

Re-read `/admin/visibility` a week later: a growing `unknown` count means a platform
changed how it serialises addressing and the fail-closed default is quietly costing
posts.

### Images

Post media and cover art are **hotlinked** from their origin CDNs — the page is
otherwise fully self-contained (no external stylesheet, font or script), and the
colophon says so rather than implying otherwise. A caching image proxy is the
intended next step; it would let the CSP tighten to `img-src 'self' data:`.

---

## Admin UI

Available at `https://yourdomain.com/admin`.

| Page | What it shows |
|---|---|
| Dashboard | Activity counts (24h / 7d), follow status, delivery errors |
| Activities | Every raw ActivityPub activity received, filterable by actor and type |
| Posts | Parsed posts and objects, searchable by text |
| Media | Books, film/TV viewings, other catalogue items and scrobbles — see below |
| Follows | Status of all follow relationships |
| Logs | Every HTTP request in and out, including signature validity |

### Media

Four tabs over everything the server holds about what you have read, watched and listened to:

| Tab | Source | One row is |
|---|---|---|
| Books | `book_metadata`, joined with the reading state derived from stored posts | a book |
| Watched | `neodb_marks` joined to `catalog_metadata`, film and TV only | **a viewing** |
| Other media | `catalog_metadata` minus film and TV — music, games, podcasts, performances | a catalogue item |
| Scrobbles | `scrobbles`, rolled up | an artist/album pair |

The Watched tab is per-viewing, not per-title: a film seen in 2016 and again in 2020 is two
rows, each with its own date and note. That is the difference from `get_watched`, which
collapses an item to its latest viewing — so the tab's row count is higher than the tool's.

Every catalogue row carries an enrichment badge (enriched / stale / failed / pending) read
from `catalog_metadata`'s fetch bookkeeping, and a **Re-enrich** button that refetches that
one item immediately — bypassing both the on-ingest "skip if already cached" rule and the
30-day staleness window, so it works on a row whose stored data is simply wrong. The Other
media tab additionally has **Retry all failed enrichments** (capped at 50 per press).

The four global sync buttons run the same jobs the scheduler runs, on demand. They are
detached: the page returns immediately and progress goes to the server log. Pressing one
twice while it is still running is a no-op, so a double-click can't stampede
BookWyrm/NeoDB/Last.fm.

### Hiding a bad record

Books and catalogue items have a **Hide** button. A hidden row stops being served: it
disappears from `get_books`, `get_watched`, `get_book_details`, `get_catalogue_details`
and the reading tools, and from the matching `/api/v1` endpoints. Pass `include_hidden:
true` to see it again. Hiding a book removes it from `get_reading_stats` and the shelf
entirely, not just its metadata — so the page and rating averages stay honest.

Hiding is a soft flag (`hidden_at`), not a delete, because a delete would not stick: both
enrichment jobs re-derive their work list from stored posts and marks, so the row would
reappear within the six-hour cycle. Enrichment never clears `hidden_at`, so a hidden row
can still be re-enriched and stays hidden. Nothing is editable by hand — if a record is
wrong, hide it, and re-enrich if upstream has since fixed it. See
[ADR 0013](docs/decision-records/0013-hide-media-rows-instead-of-deleting.md).

The Logs page is the most useful for debugging. A `✗` in the signature column means a request was rejected — this is normal for spam or misconfigured servers. If your own follows are not being received, check this page for unexpected `✗` entries on inbound requests.

---

## MCP server

The MCP endpoint is at `https://yourdomain.com/mcp`.

### Authentication

The MCP endpoint is never public. It accepts **two** kinds of credentials, so requests without
a valid one get `401`:

1. **OAuth 2.1 access token** — for browser/mobile clients like the **claude.ai connector** and
   the Claude mobile app, which can only authenticate via OAuth (they cannot send a static
   header). The server is a self-contained OAuth authorization server: it advertises discovery
   metadata, supports Dynamic Client Registration, and gates the login/consent step behind your
   **admin password** (`ADMIN_PASSWORD_HASH`). See [OAuth flow](#oauth-flow) below.
2. **Static `REST_API_KEY`** — for the Claude Code **CLI** and Claude **Desktop**, which can send
   a header. Same secret that gates the REST API, sent as `Authorization: Bearer <REST_API_KEY>`
   or `X-API-Key: <REST_API_KEY>`.

`REST_API_KEY` is optional: with it unset, the static-header path is simply disabled and OAuth
remains the way in. (Unlike the REST API, the MCP endpoint does **not** 503 when the key is
unset, because OAuth always protects it.)

### Connecting from the claude.ai app (web / mobile)

In **Settings → Connectors → Add custom connector**, enter `https://yourdomain.com/mcp` and press
**Connect**. Claude registers itself, then sends you to a consent page — enter your admin
password to approve, and the connection completes. No keys to copy.

<a id="oauth-flow"></a>The server implements these endpoints for that flow:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | Resource metadata (points clients at the auth server) |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | Login + consent (admin password), issues a PKCE auth code |
| `/oauth/token` | Exchanges the code (or a refresh token) for an access token |
| `/oauth/revoke` | Token revocation (RFC 7009) |

### Connecting from Claude Code (CLI) or Claude Desktop

These can send a static header, so use `REST_API_KEY` (replace `<REST_API_KEY>` with the value
from your `.env`):

```bash
claude mcp add --transport http activitypub \
  https://yourdomain.com/mcp \
  --header "Authorization: Bearer <REST_API_KEY>"
```

Or add it directly to an `.mcp.json` (project- or user-scoped):

```json
{
  "mcpServers": {
    "activitypub": {
      "type": "http",
      "url": "https://yourdomain.com/mcp",
      "headers": { "Authorization": "Bearer <REST_API_KEY>" }
    }
  }
}
```

### Available tools

| Tool | Example question it answers |
|---|---|
| `get_actor_posts` | "What did @alice@mastodon.social post today?" |
| `get_actor_reading_status` | "What book is @bob@bookwyrm.social currently reading?" |
| `get_actor_media` | "How many videos has @carol@loop.me posted?" |
| `search_actor_content` | "Has @alice ever talked about climate change?" |
| `get_activity_stats` | "How many posts did @carol make this month?" |
| `get_follows` | "Which accounts are being followed?" |
| `get_recent_activities` | "What has come in recently?" |
| `get_scrobbles` | "What did I listen to yesterday? Show my Aphex Twin scrobbles." |
| `get_scrobble_stats` | "Who are my top artists this month? How many tracks have I scrobbled?" |
| `get_scrobble_race` | "How far behind Taylor Swift is Maisie Peters? When will she overtake?" |
| `get_post_breakouts` | "Which of my posts are doing unusually well? Where does my engagement bar sit right now? Why haven't I had an alert?" |
| `get_reading_events` | "Show my reading timeline. When did I start and finish each book? What have I quoted?" |
| `get_reading_stats` | "What's the average length of the books I read in 2026? How many pages have I read this year? Which subjects do I read most?" |
| `get_reading_pace` | "How fast do I read? Which books did I read in parallel? What have I reread?" |
| `get_books` | "List every book in the cache. Show me all the graphic novels. Which books are tagged fantasy?" |
| `get_book_details` | "What's the page count and publisher for The Radleys?" |
| `get_watched` | "What have I marked on NeoDB? What did I watch in 2016 — watched_year=2016? Show my games from 2024, or every album by category=music. What's the IMDb link for Conflict? Everything tagged thriller. Which films did I see at the cinema — mark_comment=kino?" |
| `get_catalogue_details` | "Give me the full record for this NeoDB item — who developed it, its ISBN/publisher, the podcast feed URL — and where each field came from." |
| `get_gigs` | "Which gigs did I go to in 2023? How many times have I seen Motorpsycho? Every concert in Bergen, or at a festival. Which gigs did I write up? Which ones have a setlist with Vortex Surfer on it?" |
| `get_gig_details` | "Give me that concert in full — the line-up with roles, the setlist including encores and covers, the venue's capacity, and what I wrote about it." |
| `get_gig_stats` | "How many gigs have I been to, in how many cities? Which artist have I seen most? What's my busiest year? Which songs do I keep hearing live?" |
| `get_trip_posts` | "What did I post on Sjælland rundt? Show every togselfie with the train it was taken on. Which train was I on when I posted this?" |
| `get_trip_weather` | "What was the weather on the Bergensbanen that day? How many trips have I taken in snow? Which was the coldest journey?" |
| `get_linkedin_posts` | "What have I posted on LinkedIn this year, and how did each one do?" |
| `get_linkedin_post` | "How did the KI-buzzwords post decay — what did its reach look like across exports?" |
| `get_linkedin_stats` | "Which weekday actually earns me the best engagement rate? Is a 1.8% post good for me or bad? Is the LinkedIn token still working?" |

Unlike the REST API, these MCP tools return **every** stored post, including followers-only
ones — this is your own archive. See [ADR 0026](docs/decision-records/0026-rest-serves-public-posts-only.md).

All tools are read-only queries against the local database — no requests go out to remote servers when you query the MCP server.

### LinkedIn posts and performance

LinkedIn is the one source here whose halves come from two different places, because no
API Markus can reach has both:

| Half | Where it comes from | How |
|---|---|---|
| Post content — date, URL, commentary, visibility, attached link, reshare flag | DMA **Member Snapshot API** (`MEMBER_SHARE_INFO`) | Automatic, weekly poller |
| Performance — impressions, engagements | The analytics dashboard's **`.xlsx` Content export** | Manual, monthly, uploaded at `/admin/import` |

The manual half is deliberate, not a stopgap. Impressions and engagement rate sit behind
`r_member_postAnalytics`, inside the partner-gated Community Management product; the DMA
product carries what you posted and nothing about how it did. There is no route from one
to the other.

Both halves carry the post URL — but **not the same spelling of it**. The API emits
`/feed/update/urn:li:activity:<id>` and the export emits
`/posts/<slug>-ugcPost-<id>-<hash>`. Both embed the same numeric id, so that id is the
join key and each source's URL is stored as it arrived.

Three tools read the result:

- **`get_linkedin_posts`** — the archive, date-filterable, with each post's latest
  metrics attached. Posts appear whether or not the other half has caught up: one posted
  since the last export has `latest_metrics: null`, and one measured before the poller
  reached it has `has_content: false`.
- **`get_linkedin_post`** — one post with its full metric history. Because the export's
  impressions are a *windowed accumulation* rather than a lifetime total, metrics are
  stored append-only (one row per post per export) and this series is a reach-decay curve.
  A later row with fewer impressions means the post stopped being served, not that the
  earlier figure was wrong.
- **`get_linkedin_stats`** — totals, the p25/p75 spread, and the **median engagement rate
  per weekday**, bucketed in `Europe/Oslo`. Every weekday bucket carries `n` beside its
  medians, because with an archive this size a weekday can rest on one or two posts.

Re-running either ingest is safe. The poller upserts on the post id, and the import is
keyed on `(post id, export date)` — where the export date is read from the file's own
reporting window, not typed in, so the same file cannot land twice under two keys.

#### Minting the DMA token

The token is created **by hand** and there is no refresh flow. The product is a Digital
Markets Act compliance obligation, so **only members located in the EEA or Switzerland
can consent and generate one at all** — outside that region the flow is unavailable.

1. Create an app on the [LinkedIn Developers Platform](https://www.linkedin.com/developers/apps/).
   Use the **[Member Data Portability (Member) Default Company](https://www.linkedin.com/company/member-data-portability-member-default-company)**
   page when it asks for a LinkedIn Company Page — creating a *new* page makes the
   product un-requestable, and that is not reversible on the same app.
2. On the app's **Products** tab, request access to **Member Data Portability API (Member)**
   and accept the terms. Access is granted immediately.
3. Open **Docs and tools → OAuth Token Tools → Create token**, select the app, tick the
   **`r_dma_portability_self_serve`** scope, and consent.
4. Put the token in `/srv/bot/.env` as `LINKEDIN_DMA_TOKEN` and run
   `docker compose exec app npm run sync-linkedin` to confirm it works.

**Treat its expiry as unknown and possibly short.** When it dies you do not have to read
logs to find out: the admin dashboard shows a red *Token refused* badge, `get_linkedin_stats`
reports `source_health.token_status: "unauthorized"`, and — if ntfy is configured — one
push goes out on the transition (once per outage, not once per poll). Re-mint, update
`.env`, and re-run `docker compose exec app npm run sync-linkedin`; a success clears the
state.

**A freshly-minted token will show *Awaiting data* for a while, and that is normal.**
LinkedIn builds the snapshot as a batch job when you consent, and the activity domains
(`MEMBER_SHARE_INFO`, `ARTICLES`, `ALL_LIKES`, `ALL_COMMENTS`, `INSTANT_REPOSTS`) land
after the profile-shaped ones (`PROFILE`, `REGISTRATION`, `RICH_MEDIA`) — three hours in,
the first group can still be returning `404 No data found for this domain and memberId`
while the second answers fine. There is no published timing. `last_data_at` records when
the posts actually arrived.

**But read the note beside the badge before waiting it out.** *Awaiting data* on its own
only means no row has ever arrived; it is not a statement about the token. So on a run
that finds nothing, the poller asks `PROFILE` (does the archive exist and is the token
good?) and then `ALL_COMMENTS` (has collation actually finished?), and stores what they
answered in `last_note` (dashboard, `get_linkedin_stats`, and the `sync-linkedin` script):

- *`PROFILE` returned 401/403* — the token is refused. Recorded as a **failure**, not as
  patience: the badge turns red and the ntfy push fires.
- *`PROFILE` empty too* — the whole snapshot is missing rather than one domain being slow.
  A different problem, and it does not clear itself.
- *`ALL_COMMENTS` returned records* — activity collation has **finished** and this domain
  alone is missing. Not a wait: waiting cannot fix it and the token is demonstrably good,
  so re-minting cannot either. Report it via the DMA support form.
- *`ALL_COMMENTS` empty as well* — inconclusive, and said so rather than guessed. It is
  equally consistent with collation still running and with the member simply having no
  comments. Run the probe for the full seam.

`PROFILE` alone deliberately does **not** confirm "still collating". Profile-shaped domains
are collated *first*, so they answer while the activity ones are still assembling and go on
answering long after collation has finished — testing that claim against them is a check
that cannot come out false, which is how the explanation survived five days past the point
it was true. See [ADR 0040](docs/decision-records/0040-the-wait-was-over-and-the-state-still-said-wait.md).

**Do not re-mint the token to try to hurry it along.** LinkedIn creates the snapshot at
the moment of consent, so a fresh consent plausibly restarts the collation rather than
skipping ahead. If the activity domains are still 404 after a day while the others are
200, that is a stuck job rather than a slow one — use
[LinkedIn's DMA support form](https://www.linkedin.com/help/linkedin/ask/dsapi), quoting
the `x-li-uuid` request id the probe below prints.

#### Probing the snapshot by hand

The poller runs every 168 hours, so waiting for the next tick to learn anything is not a
diagnostic. The probe asks the endpoint directly and prints exactly what comes back — no
crawl loop, no classifier in front of it, nothing written to the database, and the token
never printed.

**Run it inside the container.** `LINKEDIN_DMA_TOKEN` comes from `.env` via Compose's
`env_file` and `DATABASE_URL` is injected by Compose and deliberately not in `.env`, so
running this on the host fails with every required variable undefined — the same trap as
the breakout scripts below:

```bash
cd /srv/bot
docker compose exec app npm run probe-linkedin                       # controls, MEMBER_SHARE_INFO, activity domains
docker compose exec app npm run probe-linkedin -- --domain ARTICLES  # one domain (repeatable)
docker compose exec app npm run probe-linkedin -- --all              # every domain LinkedIn documents
docker compose exec app npm run probe-linkedin -- --full             # untruncated bodies
docker compose exec app npm run probe-linkedin -- --json out.json    # the whole run as JSON
```

It probes the controls and the activity domains together on purpose. One domain answering
404 has four plausible explanations — wrong scope, wrong app, a uniquely broken domain, a
collation job that has not finished — and one response cannot separate them; the seam
between the two groups can. It prints a verdict line saying which stage is failing, and
exits non-zero on a 401/403 so a cron can act on it.

`docker compose exec app npm run sync-linkedin` remains the way to run a real poll on
demand — it writes rows and clears failure state — and now prints the verdict and the raw
response body alongside the counters.

The API version is pinned to `202312` in code and is deliberately not configurable: it is
the only value this endpoint accepts, it does not track the monthly DMA version numbers,
and anything else fails with `426 NONEXISTENT_VERSION`.

#### Importing the monthly export

On desktop, open your LinkedIn analytics/creator dashboard, choose **Export → Content**
for a date range (last 90 days is a good default), then upload the `.xlsx` at
`/admin/import`. Impressions and engagements are read from the **TOP POSTS** sheet, which
is two independent rankings printed side by side — one by engagements (~14 rows), one by
impressions (~50) — joined on the post URL rather than on row position. A post appearing
only in the impressions block gets a null engagement count rather than a guessed one.

The two halves are joined on a numeric post id extracted from whichever URL form each
source emitted, so a mismatch would be silent — both tables fill up and every query still
returns rows. `get_linkedin_stats` therefore reports `join_health`: `matched: 0` with
non-zero counts on both sides means the join is broken, not that there is a backlog.

See [ADR 0033](docs/decision-records/0033-linkedin-as-a-source-two-halves-joined-on-the-post-id.md),
[0034](docs/decision-records/0034-a-successful-empty-crawl-is-not-a-healthy-one.md) and
[0039](docs/decision-records/0039-a-clean-run-that-explains-nothing-is-not-observability.md).

### Last.fm scrobbles

When `LASTFM_API_KEY` and `LASTFM_USERNAME` are set, the server ingests the user's Last.fm
listening history into the local database — backfilling the full history on first run and
syncing new scrobbles every 60 seconds thereafter (tune with `LASTFM_SYNC_INTERVAL_SECONDS`).
The stored scrobbles are queryable by
timestamp, artist, album, and track via `get_scrobbles`, with aggregate metrics (totals,
listening span, top artists/albums/tracks) via `get_scrobble_stats`.

`get_scrobbles` returns newest-first by default. To answer "earliest/latest/total" questions
without paginating backward through thousands of rows:

- **First play of an artist in one call:** `get_scrobble_stats` accepts the same `artist`/`album`/`track`
  filters as `get_scrobbles`. When filtered, `first_played_at`, `last_played_at`, and `total_scrobbles`
  reflect only matching rows — e.g. `get_scrobble_stats(artist="Maisie Peters")` returns that artist's
  first and last play and total count directly.
- **Oldest matching row directly:** pass `sort_order="asc"` (default `"desc"`) with `limit=1` to
  `get_scrobbles` to fetch the earliest matching scrobble in a single call.
- **Deep traversal:** each `get_scrobbles` response includes a `next_cursor` token (a `played_at`-based
  keyset cursor, `null` when exhausted). Pass it back as `cursor` to continue from where the last page
  ended — far cheaper than large offsets. Offset-based `page` remains available for compatibility.

#### The scrobble race

Two artists can be watched head-to-head: `get_scrobble_race` reports their exact all-time
counts, the gap, the recent closing rate and a projected crossover date. Set
`RACE_LEADER_ARTIST` and `RACE_CHALLENGER_ARTIST` (plus `NTFY_PASSWORD`) and a background
watcher also pushes to ntfy as the gap closes: one alert per milestone in
`RACE_MILESTONES`, then — once the gap is inside `RACE_COUNTDOWN_GAP` — an alert on every
play that moves the number, then the two decisive rungs at a gap of 1 ("one more levels
it") and at a dead heat ("whatever you play next takes the all-time #1"), and finally the
overtake itself. The first run after enabling it seeds state silently, so switching it on
mid-race never replays the ladder.

The countdown is driven by newly ingested scrobbles, not by the polling loop: a poll that
finds no new plays sends nothing, each gap value inside the band notifies at most once,
and an ingest that brings in several plays at once sends one alert for the resulting gap
rather than one per value skipped. `get_scrobble_race` reports the band as `endgame_gap`,
and `endgame_armed` latches the first time the race is seen inside it. Setting
`RACE_COUNTDOWN_GAP=0` leaves you the ladder; the two decisive rungs and the overtake fire
regardless. See decision record 0022.

The decisive alerts fire **one play early** on purpose. A scrobbler reports what finished
playing, never what is about to start, so the only honest way to say "this one wins it" is
to say it before you press play. There is an optional live variant (`RACE_NOWPLAYING_GAP`,
off by default) that names the currently-playing track instead — but it only works if your
scrobbler sends Last.fm the separate `track.updateNowPlaying` call, which many players
never do. Verify with `get_now_playing` before enabling it. See decision record 0016.

On this account `get_now_playing` is permanently `{ nowPlaying: false }`, mid-song
included: the scrobbler has never sent `track.updateNowPlaying`, so Last.fm has no live
entry to hand back. That is now distinguishable from an outage — a failed upstream read
returns `{ nowPlaying: null, error }` and is never cached, so a momentary blip can no
longer masquerade as twenty seconds of silence. See decision record 0030.

Artist names are matched **exactly** here, unlike the substring filters on `get_scrobbles`
and `get_scrobble_stats`: a countdown that reaches zero must not have its finish line moved
by a stray collaboration credit. See decision record 0015.

### When a post does well

The background sampler already snapshots favourites, boosts and replies for every followed
account's recent posts. `BREAKOUT_ENABLED=1` puts a watcher on top of it: when one of your
posts does better than **your own usual**, you get an ntfy push while it is still happening.

The bar is a percentile of your own history, not a fixed number — 24 favourites is a quiet
day on one account and a personal best on another, and your reach changes over time. A
post's score is `favourites*1 + reblogs*3 + replies*2` (a boost reaches an audience that
was not already there; a reply costs effort; a favourite is one tap), and there are three
rungs, each firing **once** and never re-arming:

| Rung | Fires when the post passes | Push |
|---|---|---|
| p90 | the 90th percentile of that account's own recent posts | `Dette innlegget går godt` |
| p99 | its 99th percentile | `Topp 1 % — for deg` |
| record | every other post that account has ever made | `Ny personleg rekord` |

Plus one low-priority digest in the evening (`BREAKOUT_DIGEST_HOUR`, Europe/Oslo) listing
what crossed a rung and what came in across everything else. **A day with nothing to report
sends no push at all** — a nightly "nothing happened" would just train you to mute the topic.

**Switching it on**, in order. Both scripts run **inside the container** — `DATABASE_URL`
is injected by Compose and is deliberately not in `.env`, so running them on the host
fails with every required variable undefined:

```bash
cd /srv/bot
make deploy
docker compose exec app npm run db:migrate     # make deploy does NOT run migrations
docker compose exec app npm run post-breakouts # dry run: prints the bars, pushes nothing
```

Run the migration even if you are not arming the feature yet. The jobs all return at
their first guard while `BREAKOUT_ENABLED` is unset, so they never touch the table — but
`/admin/breakouts`, `get_post_breakouts` and `/api/v1/post-breakouts` read it regardless
and will error until `post_breakout_state` exists.

The dry run is the point of the exercise: it prints each account's median, p90, p99 and
record, the thresholds those become, and anything armed to fire — against the real
archive, pushing nothing. If a p90 comes out at 3 somewhere, you want to find that here
rather than at four in the morning. Only then set `BREAKOUT_ENABLED=1` in
`/srv/bot/.env` and restart. Add `-- --notify` to send for real once you are happy.

Four things worth knowing before you arm it:

- **It is off by default, and the first run is silent.** Deploy, look at where each
  account's bar actually sits, and only then set `BREAKOUT_ENABLED=1`.
  The first pass after you do records where every post already stands and announces
  nothing, so switching it on never replays your history into your phone.
- **The score is a high-water mark.** Engagement counts go down — un-favourites and undone
  boosts are real — so every score is the post's *peak* across its whole snapshot history.
  A post that reached 60 and settled at 40 keeps its rung, and cannot re-fire it on the way
  back up. It also means the record other posts are measured against can never be quietly
  lowered by someone withdrawing a like.
- **Two guards stop a quiet fortnight lying to you.** `BREAKOUT_MIN_SCORE` is an absolute
  floor every rung must clear (a p90 of 2 is arithmetic, not a compliment), and
  `BREAKOUT_MIN_POSTS` refuses to arm an account at all below that many sampled posts —
  a p99 over eight posts is "best of eight".
- **An unarmed account says which of three things is wrong**, because the fix for each is
  somewhere different: `no_posts` (nothing is being sampled at all — an ingest problem,
  not a breakout one), `no_engagement_data` (posts *are* sampled but every one scores
  zero and always has, because that origin does not report favourite/boost/reply counts
  back to us — it will never fire, whatever you set the thresholds to), and
  `too_few_posts` (the ordinary case: real engagement, not enough history yet). In
  practice only some fediverse software reports counts; expect at least one account to
  sit permanently on `no_engagement_data`.
- **Only the fast lane costs anything.** The hourly pass is chained to the sampler and
  spends zero API calls. `BREAKOUT_FAST_LANE_MINUTES` re-reads only posts from the last
  `BREAKOUT_FAST_LANE_HOURS`, capped at `BREAKOUT_FAST_LANE_MAX_POSTS` per account per
  tick, and costs nothing on a day you have not posted. To spend less, cut `MAX_POSTS`
  rather than lengthening the interval — the value is entirely in a post's first hours.

`get_post_breakouts` (and `/api/v1/post-breakouts`) reports all of it, computed **live from
the archive** rather than from the watcher's state — so it answers correctly even with
notifications unconfigured. Its `armed` list is the debugging surface: rows sitting there
with nothing arriving on your phone means the push is failing, not that nothing qualifies.
`/admin/breakouts` is the same data as a page.

Note the horizon: the sampler tracks the most recent `ENGAGEMENT_SAMPLE_RECENT_POSTS`
(default 20) posts per account, so a post that takes off after twenty newer ones have been
published is no longer sampled and can no longer break out.

See decision record 0036.

### Watch dates

Every NeoDB mark carries a shelf date — the day the film was seen, the book finished, the
album heard — and it is **not** the timestamp of the post that announced it. A film watched
in 2016 and backfilled today has a 2016 shelf date and a post published today; both are
stored, and they answer different questions.

- `get_watched` and `get_catalogue_details` return `watched_at` (the date, ISO, `null` when
  the mark carried none) and `watched_dates` (every distinct date across the item's live
  marks, newest first — an item can be marked more than once). `get_actor_posts` keeps
  reporting `published_at`, the post timestamp.
- **"What did I watch in 2016"** is one call: `get_watched(watched_year=2016)`. For any
  other span use `watched_from` / `watched_to`; a bare `YYYY-MM-DD` is read in UTC and
  covers the whole day at both ends. An item matches if *any* of its marks falls in the
  window, so a re-watched film answers under both years.
- **Ordering by history** needs `sort_by="watched_at"` (with `sort_order` for direction).
  The default `sort_by="fetched_at"` is enrichment time, which after a bulk import is just
  the order the import ran in.
- The same field serves every category: books, music, games and podcasts all carry it.

### Reading stats

Reading rows from BookWyrm carry a title, shelf, and rating but no length or finish-date
data that rolls up. Two background jobs close that gap so `get_reading_stats` can answer
aggregate questions ("average length of books read in 2026", "pages per month", a
format/author/rating breakdown):

- **Edition metadata** — for each book referenced by the actor's reading activity, the server
  fetches the BookWyrm Edition ActivityPub object and caches its `pages`, `physicalFormat`,
  `isbn13`, and publication year in a `book_metadata` table. When an Edition has no page count
  (and isn't an audiobook), it falls back to OpenLibrary then Google Books by ISBN
  (`GOOGLE_BOOKS_API_KEY` optional).
- **Reading dates** — BookWyrm does not federate exact ReadThrough dates over public
  ActivityPub, so start/finish dates are derived (day granularity) from the `readingStatus`
  BookWyrm stamps on each post: a `read` comment/review/finished-note marks a finish on that
  post's date (this is what BookWyrm renders as "finished reading"), `reading` marks a start,
  and a review counts as a finish even without a status. Consecutive start→finish signals form
  **reading cycles**, so rereads are detected and a post-finish comment doesn't drag the finish
  date later. For each actor listed in `BOOKWYRM_ACTORS`, the server walks the full outbox on
  startup and every 6 hours so these are complete even for activity that predates the follow.

The derived dates feed `get_actor_reading_status` (both live-shelf and offline modes),
`get_reading_events` (per-event signal dates plus the book's overall window), and
`get_reading_pace` (days-to-finish, pages/day, overlapping reads, rereads). Quotations
(`/quotation/` posts) are classified as their own `quotation` event type with the quoted
passage in a clean `quote` field, and progress updates (`progress`/`progress_mode`) are
surfaced when present.

`get_reading_stats` defaults to the `read` shelf and `group_by=year` (also `month`, `format`,
`author`, `rating`, `series`, or multi-valued `subject`). Page averages are reported over books
with a known page count (`pages_coverage`, e.g. "22/25 books with known page counts") rather
than silently dropping the rest, and `avg_pages_prose` excludes comics, graphic novels, and
audiobooks so a comics-heavy span doesn't skew the prose figure. Filter by `year`/`from`/`to`
(on finish date), `format`, `author`, or `rating`.

### Posts on trips

The train trips (imported from viaduct.world CSV exports) and the archived posts share
nothing but a timeline — and that turns out to be enough. A `#togselfie` is taken on the
platform at the moment of departure, so the two line up tightly: measured against the live
archive, four of four togselfies landed within six minutes of their trip's departure, one of
them within 14 seconds.

`link-trip-posts` walks that join and writes a `trip_posts` row per post: which trip, and
whether the post was made **boarding** (the 30 minutes before departure), **aboard**, or
**alighting** (the 30 minutes after arrival), plus the signed offset in seconds from
departure. `get_trip_posts` reads it from either end — the posts made on a journey, or the
trip a given post was made on — and each row carries the trip's stations, operator, rolling
stock, distance and delay, so a photo inherits all of it without anything being typed twice.

Only the accounts listed in `STREAM_SOURCES` are considered: `objects` holds strangers' posts
too (the Announce handler files a boost under its original author), and an unscoped join
would put someone else's post on Markus' train. The derivation is idempotent and diff-based —
it runs hourly, after a trip import, and on demand:

```bash
docker compose exec app npm run link-trip-posts
```

See [ADR 0023](docs/decision-records/0023-bind-posts-to-the-trips-they-were-posted-on.md) for
the matching rules and why the link lives in its own table rather than on either side.

The join has three surfaces. A post written aboard carries one line of travel context on
the public stream (*"Om bord · Göteborgs central → Oslo S · Vy · 346 km"*) — kept visibly
separate from the post's own text, because the post said none of it. `/reise` lists the
journeys and `/reise/<slug>` gives each one its route, distance, operators and everything
published along it. And `/api/v1/trip-posts` exposes the same data to non-MCP clients.

A journey's public name is *derived*, never mapped: `train_trips.journey` holds the private
CSV name ("NDC Copenhagen 2026") while the posts carry the public one (`#kodetoget`), and
the two share no characters. The page shows whichever hashtag the journey's posts carry
most, so it updates itself and reports `null` rather than guessing when there is none.
See [ADR 0024](docs/decision-records/0024-give-the-trip-post-join-a-surface.md).

### Weather on the trips

Every station in the trip history is geocoded once (OpenStreetMap/Nominatim), and the
weather on the days Markus was actually there is fetched from Open-Meteo's ERA5 archive —
both keyless, no account. `get_trip_weather` and `/api/v1/trip-weather` then join each trip
to the conditions at its origin on the departure day and its destination on the arrival
day, filterable by condition (Nynorsk: `snø`, `regn`, `klårvêr`), temperature range, journey
or station. Trip entries on the public stream gain a line like *"🌧️ regn · 12°"*.

The dates are **local** calendar days (`departure_local` / `arrival_local`), so a night
train reports the morning it arrived. Precision is not chased: ERA5 is a ~25 km
reanalysis, so a station name resolving to the right town is as good as the right
platform — which is why a bare lookup, biased by the country the trip's timezone implies,
is enough. What the geocoder matched is stored and surfaced, so a wrong hit is visible;
`source = 'manual'` pins a hand-corrected row.

The backfill is bounded (Nominatim allows one request a second), so it completes over a
few scheduler ticks. To push it along:

```bash
docker compose exec app npm run sync-weather   # repeat until it reports nothing pending
```

Weather is null wherever a station is not geocoded, the date is still inside the archive's
~7-day lag, or ERA5 has no value — a gap, never a zero. Every response states its coverage
so a thin result reads as "not fetched yet" rather than "never happened". See
[ADR 0028](docs/decision-records/0028-weather-at-the-stations-he-travelled-through.md).

---

## REST API

For collectors that don't speak MCP (cron jobs, scripts, dashboards), the same data the MCP server
exposes is available as a **read-only REST API** under `https://yourdomain.com/api/v1`. Each MCP
tool has a matching REST endpoint returning the same data, with one deliberate exception.

**REST serves public posts only.** The four endpoints that return post rows —
`/actor-posts`, `/actor-media`, `/search-actor-content` and `/trip-posts` — are pinned to
posts the origin server marked public; `unlisted` and unreadable addressing are withheld
too. The MCP tools are not: they see the whole archive, followers-only posts included.

That split is on purpose. MCP is you reading your own archive, where the private posts are
the point of keeping it. REST is what other sites consume and republish — msge.no builds
its `/togselfie` gallery this way — so it has to be safe for a consumer that does no
filtering of its own. The restriction is bound in `src/rest/table.ts`, not settable by a
query parameter, so holding the API key does not buy access to private posts. See
[ADR 0026](docs/decision-records/0026-rest-serves-public-posts-only.md).

To see exactly what that withholds from your own archive:

```bash
docker compose exec app npm run visibility-audit
```

### Auditing the scrobble history

`played_at` is the moment a track **started**, as reported by whatever scrobbler submitted
it. A scrobbler that submits at track start — Markus' does — turns a skip or a restart into
a genuine Last.fm scrobble, so the same song can appear three times in sixteen seconds and
Last.fm counts all three. The store mirrors Last.fm faithfully and does not filter them
out; a local total that disagrees with last.fm.com would not be a better truth, just a
second one.

To measure how many of those there are, and what the head-to-head would look like without
them:

```bash
docker compose exec app npm run scrobble-audit
```

It reports a spectrum of thresholds rather than one verdict, because the answer depends
almost entirely on where the line is drawn. Read-only: pure `SELECT`s inside a
`READ ONLY` transaction, and it changes no count anywhere in the app. See
[ADR 0030](docs/decision-records/0030-the-scrobble-count-is-a-mirror-not-a-judgement.md),
and [the 6 August 2026 report](docs/scrobble-audit-2026-08-06.md) for what it found the
first time it was run.

### Authentication

Every `/api/v1` request requires the `REST_API_KEY` from your `.env`, sent as either header:

```
Authorization: Bearer <REST_API_KEY>
X-API-Key: <REST_API_KEY>
```

Requests without a valid key get `401`. If `REST_API_KEY` is unset, the API is disabled and returns `503`.

### Methods

Each endpoint accepts three methods, all returning the same data:

| Method | Parameters | Use when |
|---|---|---|
| `GET` | query string (`?actor_handle=@a@b&limit=5`) | simple collectors, curl, browsers |
| `QUERY` | JSON body (identical to the MCP tool input) | rich filters; the [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html) safe, idempotent query method |
| `POST` | JSON body (identical to the MCP tool input) | compatibility fallback wherever `QUERY` isn't supported |

For `GET`, array filters are repeated params (`?object_types=Note&object_types=Article`) or
comma-separated (`?object_types=Note,Article`). For `QUERY`/`POST`, the JSON body is exactly the
arguments object you would pass the MCP tool.

### Endpoints

All paths accept `GET`, `QUERY`, and `POST`.

| REST path (under `/api/v1`) | MCP tool | Key parameters |
|---|---|---|
| `/actor-posts` | `get_actor_posts` | `actor_handle`, `limit`, `since`, `until`, `object_types`, `tag`, `sort_order`, `cursor` |
| `/actor-reading-status` | `get_actor_reading_status` | `actor_handle`, `status`, `limit`, `use_live` |
| `/actor-media` | `get_actor_media` | `actor_handle`, `media_type`, `limit`, `since` |
| `/search-actor-content` | `search_actor_content` | `query`, `actor_handle`, `limit`, `object_types` |
| `/follows` | `get_follows` | `status` |
| `/activity-stats` | `get_activity_stats` | `actor_handle`, `since` |
| `/recent-activities` | `get_recent_activities` | `limit`, `types`, `since` |
| `/reading-events` | `get_reading_events` | `actor_handle`, `event_type`, `limit`, `since`, `sort_order`, `cursor` |
| `/scrobbles` | `get_scrobbles` | `artist`, `album`, `track`, `from`, `to`, `since`, `sort_order`, `limit`, `page`, `cursor` |
| `/scrobble-stats` | `get_scrobble_stats` | `artist`, `album`, `track`, `from`, `to`, `since`, `group_by`, `limit` |
| `/scrobble-race` | `get_scrobble_race` | `leader`, `challenger`, `pace_days` |
| `/post-breakouts` | `get_post_breakouts` | `actor_handle`, `days`, `limit` |
| `/reading-stats` | `get_reading_stats` | `actor_handle`, `status`, `year`, `from`, `to`, `format`, `author`, `rating`, `group_by`, `limit` |
| `/reading-pace` | `get_reading_pace` | `actor_handle`, `year`, `from`, `to`, `sort`, `limit` |
| `/books` | `get_books` | `title`, `format`, `language`, `series`, `subject`, `sort_order`, `limit`, `page`, `cursor` |
| `/book-details` | `get_book_details` | `book_url`, `isbn`, `title` |
| `/watched` | `get_watched` | `title`, `category`, `item_type`, `genre`, `imdb`, `mark_comment`, `watched_from`, `watched_to`, `watched_year`, `include_unenriched`, `sort_by`, `sort_order`, `limit`, `page`, `cursor` |
| `/catalogue-details` | `get_catalogue_details` | `item_url`, `title`, `category` |

`GET /api/v1` returns a discovery document listing every endpoint and its parameters.

### Examples

```bash
# GET with query-string params
curl -H 'X-API-Key: YOUR_KEY' \
  'https://yourdomain.com/api/v1/scrobbles?artist=Aphex%20Twin&limit=10'

# GET only the posts carrying a hashtag (leading # optional, case-insensitive)
curl -H 'X-API-Key: YOUR_KEY' \
  'https://yourdomain.com/api/v1/actor-posts?actor_handle=@alice@mastodon.social&tag=togselfie&limit=50'

# QUERY (RFC 10008) — JSON body, identical to the MCP tool input
curl -X QUERY -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' \
  https://yourdomain.com/api/v1/actor-posts \
  -d '{"actor_handle":"@alice@mastodon.social","limit":5,"object_types":["Note"]}'

# POST — same body as QUERY, for clients/proxies without QUERY support
curl -X POST -H 'X-API-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  https://yourdomain.com/api/v1/follows -d '{"status":"all"}'
```

Responses use standard status codes: `400` (invalid parameters), `401` (missing/invalid key),
`404` (e.g. an actor handle that can't be resolved), `503` (API key not configured).

### OpenAPI spec

A full machine-readable description of the HTTP API — the REST endpoints above plus the
ActivityPub federation, discovery (WebFinger/NodeInfo) and health endpoints — lives at
[`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1). Load it into Swagger UI, Redoc, Postman,
or any OpenAPI client to browse schemas and generate request code.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on startup.

---

## Troubleshooting

**The actor is not discoverable / WebFinger returns 404**
- Confirm your DNS A record points to the VPS IP: `dig A bot.example.com`
- Confirm the central Caddy instance is running and has obtained a TLS certificate for your domain
- Confirm `APP_DOMAIN` in `.env` exactly matches your domain

**Follows stay in `pending` forever**
- Some servers take time to process Follow requests. Wait a few hours.
- Check the Logs page in the admin UI for delivery errors on outbound requests.
- If you see HTTP 401 or 403 errors, the remote server rejected your HTTP Signature. Check that your actor URL is publicly accessible and returns valid JSON.

**Activities are not arriving**
- Confirm the inbox is reachable: `curl -X POST https://yourdomain.com/actor/inbox` should return 401 (signature missing), not a network error.
- Check the Logs page for inbound requests. If you see entries with `✗` signature, the remote server is sending requests but they are failing verification — check the error column for details.
- Some servers use the shared inbox (`/inbox`) instead of the actor inbox. Both are handled identically.

**A NeoDB mark is not showing up in `get_watched`**
- The mark has to have arrived first: check the Activities page for a `Create`, `Announce` or `Update` carrying the mark's `Note`. Marks made in the NeoDB UI arrive as pushed `Create`/`Update` activities; marks crossposted to Mastodon also arrive as an `Announce` of the same note (the boost is unwrapped and does not create a second post).
- Rebuild the derived data from what is already stored: **Admin → Import → Repair NeoDB Marks**, or on the server `docker compose exec app npm run repair-neodb-ingest`. It re-derives missing post text, rebuilds the mark store, and enriches every catalogue item the stored marks tag. Nothing is re-marked on NeoDB and no post is re-federated, so it is safe to run repeatedly.
- Marks are routinely backdated (NeoDB keeps the date you watched something, which can be years ago). Nothing filters on recency — look for the item by title rather than at the top of a date-sorted list.

**A mark shows up but `watched_at` is today, not the real date**
- minreol does not federate a backdated mark on creation: the `Create` carries today's date and a follow-up `Update` (usually seconds later) carries the real one. Check the Activities page for the `Update`; if it never arrived, re-save the mark on NeoDB.
- For marks ingested before the column existed, the date is recovered from the stored payload by **Admin → Import → Repair NeoDB Marks** (or `npm run repair-neodb-ingest`), which also runs once automatically on the first startup after deploying. It only ever fills a blank date, so it will not overwrite one that is already right.

**Gigs are missing, or every concert appears twice**
- Gigowl moved from `samklang.msge.no` to `gigowl.social` and renamed its paths at the same
  time (`/konsert/` → `/gig/`, `/oppmote/` → `/attendance/`, `/brukar/` → `/user/`). The old
  address 301s, but the gig store is *keyed* on those URLs and a key does not follow a
  redirect — so an archive that has not been rebased forks in two. See decision record
  [0038](docs/decision-records/0038-follow-gigowl-at-its-new-address.md).
- Point `FOLLOW_ACTORS` and `STREAM_SOURCES` at `@markus@gigowl.social` (the `|samklang`
  platform slug does not change — that is the NodeInfo software name, which did not move),
  then rebase what is stored:
  ```bash
  docker compose exec app npm run db:migrate
  docker compose exec app env DRY_RUN=1 npm run rebase-gig-origin
  docker compose exec app npm run rebase-gig-origin
  ```
  The migration is not optional: without it the `trip_posts` foreign key forbids renaming an
  `objects` row and the rebase refuses to run. The rebase itself is one transaction, so a
  failure leaves the archive exactly as it was; it is idempotent, touches nothing but
  Gigowl's own identifiers, and drops the follow row for the old address so the next startup
  sends a real `Follow` to the new account.

**Container fails to start**
```bash
docker compose logs app
```
Common causes: missing required env vars (the app prints which ones are missing and exits), or the database is not reachable.

**Resetting the database**
```bash
docker compose down -v   # removes all volumes including the database
docker compose up -d --build
```
This also deletes the stored RSA keypair. Your actor will get a new keypair on next startup, which means existing follows will need to be re-sent (they are re-sent automatically on startup).
