# 0073 — a mobile-first admin in nynorsk

**Status:** Accepted (all four phases)
**Date:** 2026-11-01
**Topics:** admin, design, mobile
**Contributors:** Markus (design handoff "Admin mobil v3"; decided: stacked PRs, dry-run
imports as their own later phase, old URLs answer 301) + Claude (implemented)

**Affects:** `src/admin/views/logs.tsx`, `src/admin/import-kinds.ts`, `src/admin/import-runs.ts`, `drizzle/0047_import_runs.sql`,
`src/admin/views/import.tsx`, `src/admin/category-router.tsx`, `src/admin/views/kit.tsx`,
`src/admin/views/media-tabs.tsx`, `src/admin/views/other-tabs.tsx`, `src/admin/media-router.tsx`,
`src/admin/views/layout.tsx`, `src/admin/views/dashboard.tsx`,
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

### Phase 2: category pages

- Every old page is a tab of `/admin/k/:kategori`, loaded by the query it always ran
  (`category-router.tsx`). Old URLs answer **301** with their filters kept, after the
  session gate so a logged-out browser never caches a permanent redirect.
- Tables became rows: cover, title, a sub line, badges, and on the right a metric, one
  action (**Fest**), or a ⋯ sheet with **Berik på nytt**, **Skjul / Vis igjen** and
  **Opne kjelde**. The sheet is one `<dialog>` per page filled from the tapped row: the
  only script, and its forms post to the same `/admin/media/*` endpoints as before.
- Rows with raw data (activities, posts, withheld addressing) open in place, `<details>`.
- One search box per tab; every other filter the old pages had sits in a **Filter** fold
  of the same GET form, so no filter was lost to fit a phone.
- "Other media" is split as the handoff asks (Spel, Album, Podkastar) and the rest stays
  reachable as **Sjåing → Heile katalogen**: NeoDB also holds books, performances and
  rows of unknown category, and the failed-enrichment card on Oversikt needs one list of
  every failure. Lesingar, Turar, Ruter, LinkedIn Innlegg/Statistikk and Jobbar are new
  data views and come in their own PR.
- The station pin redirects back to the tab with a `notice`/`error` instead of
  re-rendering on POST, so a reload cannot pin twice.
- Flash messages from POST actions are nynorsk and render as a toast.

### Phase 3: Import

- `/admin/import` lists every import under its category, with when it last ran;
  `/admin/import/:kind` is one page per import, and the POST it sends is the one it always
  was (`/admin/import/:kind`). The kinds live in `import-kinds.ts`, keyed by that segment,
  and a test holds the category list and the kinds to each other.
- **`import_runs`** (migration 0047) is written after every run, from the admin: `ok`, a
  one-line `summary`, or the `error` that refused it. A row is an outcome, never an intent,
  and a failed write of it is logged and never fails the import. The trip prune is not
  recorded: it is the second half of a trips import, not a run of its own.
- The flow has **two steps**, Vel fil → Ferdig. Dry run adds "Sjå over" between them in its
  own PR, so no step promises something that does not exist yet.
- A refused upload re-renders its own page with the reason (HTTP 422), and every one of
  them is refused before anything is written, which is what lets the banner say so.
- Result pages keep every list they had (the trips "not in this export" list and its
  confirm, StoryGraph conflicts, YouTube normalisations) as rows, and end with the way
  back to the category and to Oversikt.

### Phase 4: Loggar

- Filter chips (Alle · Inn · Ut · Feil · Ugyldig signatur) as one GET parameter, `f`.
  The old `direction` and `sigValid` links still resolve to the same chip, and an actor
  filter from a URL is kept in every link and shown as a removable pill.
- **Feil** is a status of 400 or more, or a request that never got one (`error` set).
- One card per request: direction, method, status (red from 400), signature, time in Oslo
  (a clock time today, a date before that), the URL and the actor's handle. Tapping opens
  the error and the body in place.
- The list still polls every 10 s, and the trigger skips a tick while any card is open,
  so a body being read is never swapped away.
- The delivery-error card on Oversikt links to `?f=ut`, the handoff's choice.

## Consequences

- The delivery-error count on Oversikt is now the last 24 hours, and only ≥ 400. The old
  tile counted every outbound status above 299 for all time, so it could never return to
  zero and a card built on it could never be cleared.
- Category tiles link to today's pages until phase 2 gives them their own.
- IBM Plex is loaded from Google Fonts, the same way htmx already comes from unpkg.
