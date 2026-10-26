# Renaming the service

Runbook for ADR 0070: renaming `activitypub-mcp` to `markivaren`. It lists every place
the name lives and the order to change them in. Nothing here has been done yet.

## Order

1. **This repo** (one PR): identity strings, outward-facing strings, "formerly" notes.
2. **GitHub repo rename** (Settings → General → Repository name), right after that PR
   merges.
3. **The box and naustet-server**: remote URL, service docs, badge, inventory.
4. **Agents last**: the claude.ai connector, then the skills and memory that name it,
   in the same sitting.

Each step works on its own. Stopping after any of them leaves nothing broken.

## 1. This repo

### Identity (plain find and replace)

| Where | Today |
|-------|-------|
| `package.json` `name` (then `npm install` to refresh `package-lock.json`) | `activitypub-mcp` |
| `src/mcp/server.ts:46` MCP server `name` | `activitypub-mcp` |
| `src/rest/router.ts:73` REST `service` label, and its example in `docs/openapi.yaml` | `activitypub-mcp REST API` |
| `docs/openapi.yaml` `title` and intro paragraph | `activitypub-mcp API` |
| `src/stream/feed.ts:167` Atom `<generator>` | `activitypub-mcp` |
| `README.md` title and badge URL | `ActivityPub MCP Server` |
| `AGENTS.md` heading and the service tables | `activitypub-mcp` |
| `docs/decision-records/README.md` intro line | `activitypub-mcp` |
| `src/oauth/views/authorize.tsx:59` OAuth consent text | "your ActivityPub MCP server" |
| `src/config.ts:6` `APP_DISPLAY_NAME` default | `ActivityPub MCP Bot` |

`APP_DISPLAY_NAME` is the actor's display name on the fediverse. Check whether
`/srv/bot/.env` overrides it before assuming the default is what people see.

### Outward-facing (change on purpose)

Remote admins read these. Keep the `+https://bot.skvip.lol` contact URL in every one.

| Where | Today |
|-------|-------|
| `src/lib/fetch-engagement.ts:15` | `activitypub-mcp/1.0 (+https://…)` |
| `src/lib/thread-fetch.ts:26` | same |
| `src/lib/fetch-youtube-videos.ts:20` | same |
| `src/lib/probe-youtube-short.ts:20` | same |
| `src/lib/geocode-station.ts:36` | same (Nominatim policy requires an identifying UA) |
| `src/lib/fetch-linkedin-snapshot.ts:192` | same |
| `src/lib/bookwyrm-fetch.ts:14` | `activitypub-mcp/1.0 (BookWyrm/0.7.5; +https://…)` |
| `src/lib/fetch-storygraph.ts:65` | `activitypub-mcp/1.0 (sync-storygraph)` |
| `src/lib/wayback.ts:70` | `activitypub-mcp legacy image recovery (bot.skvip.lol)` |
| `src/activitypub/nodeinfo.ts:8-10` `SOFTWARE_NAME` and `REPOSITORY` | `activitypub-mcp`, `github.com/mmsge/activitypub-mcp` |
| `src/activitypub/nodeinfo.test.ts:57,87` | the expectations for the two above |

Seven of the User-Agents are the same template. Pulling it into one constant in
`src/config.ts` would make the next rename a one-line change.

### For agents

- **A "formerly" line** at the top of `AGENTS.md` and `README.md`:
  "markivaren is Markus' personal archive (formerly activitypub-mcp, connector
  `Markus_ActivityPub`)."
- **MCP `instructions`** in `createMcpServer()`: today the server sets none. Add a short
  paragraph naming what it covers (posts, books, films and TV, theatre, gigs, scrobbles
  and races, trains, YouTube, LinkedIn, StoryGraph, garden pages, Twitter archives) and
  the "formerly" line. Agents choose tools from this text, not from the server name.
- **Bump the MCP server `version`** (minor: nothing about the tools changes).

### Leave alone

- **The ADRs.** They are history. 0070 records the rename.
- **The database** (`activitypub`, `apuser`, `docker-compose.yml`, `.env.example`).
  Invisible, and renaming it needs a migration.
- **`name: bot`, `/srv/bot`, `bot.skvip.lol`, port 3000.** Already neutral. The Compose
  project name is what keeps the volumes attached.
- **Code identifiers** like `src/activitypub/`. That folder really is the ActivityPub
  part of the service.

### Verify

`npm test` (the NodeInfo test pins the name), `npm run lint`, then
`grep -rIn -i "activitypub-mcp" --exclude-dir=node_modules --exclude-dir=.git .`
should only hit the ADRs and the "formerly" lines.

## 2. GitHub

Rename `mmsge/activitypub-mcp` to `mmsge/markivaren`. GitHub redirects the web URL and git
remotes, so nothing breaks at once. Do not create a new repo under the old name later:
that kills the redirect.

## 3. The box and naustet-server

- On the box: `cd /srv/bot && git remote set-url origin git@github.com:mmsge/markivaren.git`.
  `/srv/bot` itself stays.
- In `mmsge/naustet-server`:
  - rename `services/activitypub-mcp.md` and update its contents,
  - update the comment on this service's Caddyfile block (the routing does not change),
  - update the service registry entry the Naustet_Box tools read,
  - check anything keyed on the repo slug: the utrulla badge
    (`utrulla.msge.no/badge/mmsge/activitypub-mcp`), the ADR pool at `adr.msge.no`,
    the log collector's service name.
- Other repos that mention this one by name: `mmsge/storygraph-leser` (sidetal),
  msge.no's webhook registry, bartenderen. A search for `activitypub-mcp` across
  `mmsge` finds them.

## 4. Agents

Do this last, and do all of it in one sitting.

1. **The claude.ai connector** (Settings → Connectors). Renaming it changes every tool
   name from `mcp__Markus_ActivityPub__*` to `mcp__Markivaren__*`. Until this step the
   old connector name keeps working: the repo and the connector do not have to match.
2. **Skills** that name the service or the tool prefix. Known: `dagbok-etterfyll`,
   `mastodon-tut-redaktor`. Search the rest for `ActivityPub` and `Markus_ActivityPub`.
3. **Memory and project instructions** in claude.ai and Cowork that mention the old name.
4. **Scheduled tasks** whose stored prompts mention the old tools.
