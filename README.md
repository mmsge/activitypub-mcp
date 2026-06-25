# ActivityPub MCP Server

A personal ActivityPub actor that follows other accounts, archives their posts in PostgreSQL, and exposes an MCP server so AI agents can query the data.

Works with **Mastodon**, **BookWyrm**, **Pixelfed**, and **Loops**.

## How it works

- The server has its own ActivityPub identity (an actor with a public/private RSA keypair).
- You configure which accounts to follow via an environment variable. On startup, the server sends Follow requests to any account not already followed.
- Incoming activities (posts, boosts, book updates, etc.) are verified, stored, and parsed. BookWyrm reading data gets its own structured table.
- The server **auto-rejects all incoming Follow requests** — it is a read-only bot, not a social participant.
- An admin UI at `/admin` lets you review stored data and inspect every HTTP request the server has handled, including signature validity.
- An MCP server at `/mcp` lets AI agents answer questions like "What did this user post today?" or "What book is this user currently reading?"

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
git clone <your-repo-url> /opt/activitypub-mcp
cd /opt/activitypub-mcp
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
| `DB_PASSWORD` | Yes | Password for the PostgreSQL database. Choose something strong. |
| `FOLLOW_ACTORS` | Yes | Comma-separated list of handles to follow (see below) |
| `ADMIN_PASSWORD_HASH` | Yes | The bcrypt hash you generated in step 3 |
| `SESSION_SECRET` | Yes | A random 32-byte hex string (generate with the command below) |
| `LASTFM_API_KEY` | No | Last.fm API key ([create one](https://www.last.fm/api/account/create)). Enables scrobble ingestion. |
| `LASTFM_USERNAME` | No | The Last.fm username whose scrobbles are ingested. Required alongside `LASTFM_API_KEY`. |
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

## Admin UI

Available at `https://yourdomain.com/admin`.

| Page | What it shows |
|---|---|
| Dashboard | Activity counts (24h / 7d), follow status, delivery errors |
| Activities | Every raw ActivityPub activity received, filterable by actor and type |
| Posts | Parsed posts and objects, searchable by text |
| Follows | Status of all follow relationships |
| Logs | Every HTTP request in and out, including signature validity |

The Logs page is the most useful for debugging. A `✗` in the signature column means a request was rejected — this is normal for spam or misconfigured servers. If your own follows are not being received, check this page for unexpected `✗` entries on inbound requests.

---

## MCP server

The MCP endpoint is at `https://yourdomain.com/mcp`.

Connect to it from any MCP-compatible AI client (Claude Desktop, Claude Code, etc.) by adding it as an MCP server with the URL above.

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

All tools are read-only queries against the local database — no requests go out to remote servers when you query the MCP server.

### Last.fm scrobbles

When `LASTFM_API_KEY` and `LASTFM_USERNAME` are set, the server ingests the user's Last.fm
listening history into the local database — backfilling the full history on first run and
syncing new scrobbles every 5 minutes thereafter. The stored scrobbles are queryable by
timestamp, artist, album, and track via `get_scrobbles`, with aggregate metrics (totals,
listening span, top artists/albums/tracks) via `get_scrobble_stats`.

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
