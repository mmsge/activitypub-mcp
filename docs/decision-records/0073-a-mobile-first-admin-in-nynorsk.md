# 0073 — a mobile-first admin in nynorsk

**Status:** Accepted (phase 1 of 4)
**Date:** 2026-11-01
**Topics:** admin, design, mobile
**Contributors:** Markus (design handoff "Admin mobil v3"; decided: stacked PRs, dry-run
imports as their own later phase, old URLs answer 301) + Claude (implemented)

**Affects:** `src/admin/views/layout.tsx`, `src/admin/views/dashboard.tsx`,
`src/admin/views/login.tsx`, `src/admin/views/linkedin.tsx`, `src/admin/attention.ts`,
`src/admin/categories.ts`, `src/admin/router.tsx`, every view under `src/admin/views/`

## Context

`/admin` grew one top-nav link per feature until the nav no longer fit on a phone, and
the dashboard explained itself in long English paragraphs before showing a number. It is
mostly used from a phone.

## Decision

Rebuild it from the handoff, keeping the stack: server-rendered Hono JSX, forms that POST,
pages that GET, and as little JavaScript as possible.

- **The shell.** A 56 px header with the page title, one scrolling column, and a bottom bar
  of four items (Oversikt, Import, Loggar, Meir). Meir is a native `<dialog>` sheet holding
  the seven categories and Logg ut. From 900 px the bar is a 220 px left rail with the
  categories listed under it, and the content stays a 640 px column.
- **Seven categories** (Lesing, Sjåing, Musikk, Reiser, Fediverse, LinkedIn, System) are one
  list in `categories.ts`, so the tiles, the sheet and the rail cannot drift.
- **Oversikt leads with what needs attention.** `attentionItems()` is a pure function over
  counts the page already queries, and each card deep-links to the cause. The rules: a
  refused LinkedIn token (red), outbound responses ≥ 400 in the last 24 hours (red), failed
  enrichments (yellow), pending follows (yellow). Nothing → a green all-clear.
- **Explanations are folded away** behind an ⓘ, opened inline without script by a hidden
  checkbox and its label. Not `<details>`: its summary and panel are one element, so the
  button cannot end a row while the panel opens under the whole row.
- **UI copy is nynorsk.** Pages not yet rebuilt keep their English until their phase.

### Phases

1. Tokens, shell, login, Oversikt (this record). The other pages render inside the new
   shell, restyled through the shared classes. LinkedIn health moved off the dashboard to
   `/admin/linkedin` until its category page exists.
2. Category pages at `/admin/k/:kategori?tab=…`; old URLs answer 301.
3. Import list and flow, restyled, on today's direct import.
4. Loggar. Dry-run previews for every file import follow as their own work.

## Consequences

- The delivery-error count on Oversikt is now the last 24 hours, and only ≥ 400. The old
  tile counted every outbound status above 299 for all time, so it could never return to
  zero and a card built on it could never be cleared.
- Category tiles link to today's pages until phase 2 gives them their own.
- IBM Plex is loaded from Google Fonts, the same way htmx already comes from unpkg.
