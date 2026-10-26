# 0070 — The archive is named for what it keeps, not the protocol it started with

**Status:** Proposed (draft: the name is not final)
**Date:** 2026-10-26
**Topics:** naming, rename, agents, mcp, connector, fediverse
**Contributors:** Markus (asked for a new name because the service is now a personal archive with many non-ActivityPub sources; worried that agents who know the old name will get confused; shortlisted munin, varden, skjora, tidsvitnet and ferdaminne, with munin the top contender) + Claude (surveyed where the name lives, proposed the shortlist and the staged plan)

**Affects:** `package.json`, `src/mcp/server.ts`, `src/activitypub/nodeinfo.ts`,
`src/rest/router.ts`, `src/stream/feed.ts`, `src/config.ts`,
`src/oauth/views/authorize.tsx`, the outbound User-Agent strings in `src/lib/`,
`docs/openapi.yaml`, `README.md`, `AGENTS.md`, plus `mmsge/naustet-server` and the
claude.ai connector and skills outside this repo. The runbook is
[`docs/renaming.md`](../renaming.md).

## Context

The service started as an ActivityPub bot that follows Markus' accounts and archives
what they post. It now also holds Last.fm scrobbles, train trips from viaduct.world,
YouTube watch history, LinkedIn posts and metrics, StoryGraph journal entries and read
dates, Obsidian garden pages, two Twitter archives, gigs, theatre and the watchers that
push alerts over all of it. Many of these sources have nothing to do with ActivityPub.
`activitypub-mcp` describes how it began, not what it is: Markus' personal archive.

The name is in three kinds of place, and they matter differently:

1. **Inside this repo.** About twenty hardcoded strings. The infrastructure names are
   already neutral: the Compose project is `bot`, the box path is `/srv/bot`, the domain
   is `bot.skvip.lol`, the port is 3000.
2. **Facing other servers.** The User-Agent on every outbound fetch and the NodeInfo
   `software.name`. Remote admins read these. ADR 0058's incident was noticed by the
   admin of a server we polled, so changing them deserves thought.
3. **Facing agents.** Agents reach this service through tools prefixed
   `mcp__Markus_ActivityPub__`. That prefix comes from the connector's name in claude.ai,
   not from this repo. Skills (`dagbok-etterfyll`, `mastodon-tut-redaktor`) and memory
   refer to "the ActivityPub MCP" by name. This is where an agent that knows the old name
   gets confused.

## Decision

**Rename the service to `munin`** (proposed; see the shortlist below), and stage the
change so agents are never left with a name that matches nothing.

1. **Rename the repo-side identity in one PR.** Package name, MCP server name, REST
   service label, Atom generator, OpenAPI title, README, AGENTS.md, the OAuth consent
   text and the default display name. The ADRs are history and keep the old name.
2. **Change the outward-facing strings on purpose.** The User-Agent becomes
   `munin/1.0 (+https://bot.skvip.lol)`. The contact URL stays, so a remote admin can
   still trace the requests. NodeInfo `software.name` and its repository URL follow.
3. **Keep a "formerly" line wherever an agent might search for the old name.** The top
   of `AGENTS.md` and `README.md`, and the MCP server's `instructions`: "munin is
   Markus' personal archive (formerly activitypub-mcp, connector `Markus_ActivityPub`).
   It is not the Munin server-monitoring tool." Same pattern as samklang to Gigowl
   (ADR 0038).
4. **Give the MCP server a description of what it covers.** Agents pick tools by
   description, not by server name. Today the server sets no `instructions` at all.
5. **Rename the claude.ai connector last, in its own step**, together with the skills
   that name it. The repo name and the connector name do not have to match, so the
   connector can keep its old name for as long as that is useful. When it changes,
   prefer a name that reads as Markus' own (`Markus_Munin` or `Munin_Arkiv`) over a bare
   `Munin`.
6. **Do not rename the database.** `activitypub` / `apuser` is invisible to people and
   agents, and renaming it costs a migration and a risky deploy for nothing visible.
7. **Do not rename the box path, the Compose project or the domain.** They are already
   neutral, and the Compose project name is what keeps the volumes attached.

### The shortlist

| Name | Image | Agent legibility |
|------|-------|------------------|
| **munin** | Odin's raven of memory, which flies out every day and comes back with what it saw | High: agents know the myth. Clashes with the Munin monitoring tool |
| varden | The cairn, stones stacked where someone walked so the way can be found again | Low: the description must carry it |
| skjora | The magpie carrying every shiny thing home | Low, playful |
| tidsvitnet | A witness to the time | Medium, if you read Nynorsk |
| ferdaminne | Travel memories (Vinje) | Medium, but reads as travel only |

Rejected along the way: names that are straight references to book titles (mima,
flaskesamlaren, funiculi, trenzalore, funes, aleph). Markus wanted an image, not a
citation.

## Consequences

- GitHub redirects the old repo URL for the web and for git, so existing clones,
  `make deploy` on the box and old links keep working. The box's remote should still be
  updated so the redirect is not load-bearing forever.
- Remote servers see a new User-Agent. Any of them that allow-listed the old string
  would start refusing us. None is known to, and the contact URL is unchanged.
- NodeInfo crawlers will list the instance under a new software name.
- The utrulla deploy badge and the Naustet_Box inventory are keyed on
  `mmsge/activitypub-mcp` and must move in `mmsge/naustet-server`.
- Until the connector is renamed, agents keep calling `mcp__Markus_ActivityPub__*` and
  everything works. After it is renamed, any skill, memory or prompt naming the old
  prefix stops matching, which is why that step goes last and together with the skills.
- "Munin" alone is ambiguous on a box where agents also talk about monitoring. The
  "not the monitoring tool" line is what resolves it, so it must not be trimmed as
  redundant.
