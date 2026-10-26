# 0070 — The archive is named for what it keeps, not the protocol it started with

**Status:** Accepted (the rename itself is not done yet; see `docs/renaming.md`)
**Date:** 2026-10-26
**Topics:** naming, rename, agents, mcp, connector, fediverse
**Contributors:** Markus (asked for a new name because the service is now a personal archive with many non-ActivityPub sources; worried that agents who know the old name will get confused; rejected munin for its clash with the Munin monitoring tool and muna as a product name; chose markivaren over marchive) + Claude (surveyed where the name lives, proposed the candidates and the staged plan)

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

**Rename the service to `markivaren`**: Markus + *arkivaren*, "Markus' archivist". It is
a personal tool, so the name only has to be unmistakable, not marketable. It sits in the
box's *-aren* family (tekaren, bartenderen), it almost certainly exists nowhere else,
and an agent can read *arkivar* in it without knowing Nynorsk.

The change is staged so agents are never left with a name that matches nothing.

1. **Rename the repo-side identity in one PR.** Package name, MCP server name, REST
   service label, Atom generator, OpenAPI title, README, AGENTS.md, the OAuth consent
   text and the default display name. The ADRs are history and keep the old name.
2. **Change the outward-facing strings on purpose.** The User-Agent becomes
   `markivaren/1.0 (+https://bot.skvip.lol)`. The contact URL stays, so a remote admin
   can still trace the requests. NodeInfo `software.name` and its repository URL follow.
3. **Keep a "formerly" line wherever an agent might search for the old name.** The top
   of `AGENTS.md` and `README.md`, and the MCP server's `instructions`: "markivaren is
   Markus' personal archive (formerly activitypub-mcp, connector `Markus_ActivityPub`)."
   Same pattern as samklang to Gigowl (ADR 0038).
4. **Give the MCP server a description of what it covers.** Agents pick tools by
   description, not by server name. Today the server sets no `instructions` at all.
5. **Rename the claude.ai connector last, in its own step**, to `Markivaren`, together
   with the skills that name it. Until then the old connector name keeps working.
6. **Do not rename the database.** `activitypub` / `apuser` is invisible to people and
   agents, and renaming it costs a migration and a risky deploy for nothing visible.
7. **Do not rename the box path, the Compose project or the domain.** They are already
   neutral, and the Compose project name is what keeps the volumes attached.

### Alternatives considered

| Name | Why not |
|------|---------|
| munin | Odin's raven of memory, the favourite for a while. Munin is also a long-standing server-monitoring tool, and the box is exactly where agents talk about monitoring. Fencing it off with a "not the monitoring tool" line would rely on that line surviving forever |
| muna | The Old Norse root of Muninn, "to remember". No clash, but it reads as a product name, and this is a personal tool |
| marchive | Markus + archive. Short, but on sight it can read as "March archive", and as an English word it is more likely to exist elsewhere |
| varden, skjora, tidsvitnet, ferdaminne | Poetic, but the name says nothing about what the service is, so the description would have to carry all of it |
| mima, flaskesamlaren, funiculi, trenzalore, funes, aleph | Straight references to book titles. Markus wanted an image, not a citation |

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
