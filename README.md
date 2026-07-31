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
- An admin UI at `/admin` lets you review stored data and inspect every HTTP request the server has handled, including signature validity.
- An MCP server at `/mcp` lets AI agents answer questions like "What did this user post today?" or "What book is this user currently reading?"
- A read-only **REST API** at `/api/v1` exposes the same data to non-MCP clients (scripts, cron jobs, dashboards), gated by an API key.

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
| `DB_PASSWORD` | Yes | Password for the PostgreSQL database. Choose something strong. |
| `FOLLOW_ACTORS` | Yes | Comma-separated list of handles to follow (see below) |
| `ADMIN_PASSWORD_HASH` | Yes | The bcrypt hash you generated in step 3 |
| `SESSION_SECRET` | Yes | A random 32-byte hex string (generate with the command below) |
| `REST_API_KEY` | No | Shared secret for header-based access. Required to enable the read-only REST API at `/api/v1` (blank ⇒ `503`). Also accepted as a static-header credential for `/mcp` (the CLI/Desktop path); blank just disables that path — `/mcp` stays protected by OAuth. Generate like `SESSION_SECRET`. |
| `LASTFM_API_KEY` | No | Last.fm API key ([create one](https://www.last.fm/api/account/create)). Enables scrobble ingestion. |
| `LASTFM_USERNAME` | No | The Last.fm username whose scrobbles are ingested. Required alongside `LASTFM_API_KEY`. |
| `LASTFM_SYNC_INTERVAL_SECONDS` | No | How often to poll Last.fm for new scrobbles, in seconds. Default `60`, minimum `15`. |
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

It should appear as a profile. If it does not, check `docker compose logs app` for errors and confirm your DNS record is pointing to the correct IP.

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
| `get_reading_events` | "Show my reading timeline. When did I start and finish each book? What have I quoted?" |
| `get_reading_stats` | "What's the average length of the books I read in 2026? How many pages have I read this year? Which subjects do I read most?" |
| `get_reading_pace` | "How fast do I read? Which books did I read in parallel? What have I reread?" |
| `get_books` | "List every book in the cache. Show me all the graphic novels. Which books are tagged fantasy?" |
| `get_book_details` | "What's the page count and publisher for The Radleys?" |
| `get_watched` | "What have I marked on NeoDB? What did I watch in 2016 — watched_year=2016? Show my games from 2024, or every album by category=music. What's the IMDb link for Conflict? Everything tagged thriller. Which films did I see at the cinema — mark_comment=kino?" |
| `get_catalogue_details` | "Give me the full record for this NeoDB item — who developed it, its ISBN/publisher, the podcast feed URL — and where each field came from." |

All tools are read-only queries against the local database — no requests go out to remote servers when you query the MCP server.

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

---

## REST API

For collectors that don't speak MCP (cron jobs, scripts, dashboards), the same data the MCP server
exposes is available as a **read-only REST API** under `https://yourdomain.com/api/v1`. Each MCP
tool has a matching REST endpoint that returns **identical** data.

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
