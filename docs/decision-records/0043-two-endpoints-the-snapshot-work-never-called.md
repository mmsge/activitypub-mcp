# 0043 — Two endpoints the snapshot work never called: ask about the consent, and reconsider the changelog

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (asked for the documentation to be checked again before concluding, which is what surfaced both of these) + Claude (agent decisions: re-read the DMA docs end to end, found `memberAuthorizations` and re-opened the Changelog question, and made both readings three-state rather than boolean)
- **Affects:** `src/lib/fetch-linkedin-snapshot.ts`, `src/lib/linkedin-probe.ts`, `scripts/probe-linkedin-snapshot.ts`
- **Topics:** linkedin, ingest, diagnostics, api

Extends [0042](0042-a-diagnostic-nobody-can-read-is-not-a-diagnostic.md). Re-opens a
decision from [0033](0033-linkedin-as-a-source-two-halves-joined-on-the-post-id.md).

## Context

ADR 0042 concluded that `MEMBER_SHARE_INFO` is absent from an otherwise comprehensive
archive and that the only action left was a support ticket. Before sending it, the
documentation was read again from the top. That re-read confirmed the parts already
relied on and turned up two things the work had never touched.

**What the re-read confirmed.** `2026-05` is the latest doc set. The scope for the Member
(self-serve) product is `r_dma_portability_self_serve`, which is what the token carries.
`Linkedin-Version: 202312` is still the only accepted value. `start` is still a page
index. `MEMBER_SHARE_INFO` is **not** deprecated — the deprecations are `GROUP_POST`,
`MEMBER_HASHTAG`, `NAME_CHANGES`, `SAVED_PEOPLE_SEARCHES` and `VOLUNTEERING` — and no
domain has been renamed or split. There is still **no archive-request call** for the
snapshot: it is created at the moment of consent. The request shape was right.

*(Incidentally: `MEMBER_HASHTAG` is on that deprecation list and still returned a record
in the walk, so the unfiltered query surfaces domains the named API no longer documents.
Which is a small argument that the walk sees *more* than the domain table, not less.)*

**What it turned up.**

1. **`GET /rest/memberAuthorizations?q=memberAndApplication`.** Documented under the
   Changelog API as the "member FINDER" call, but it does not describe the changelog —
   it describes the **consent**. It returns `regulatedAt`, the moment LinkedIn began
   monitoring and archiving for this member, plus `memberComplianceScopes` and the
   developer application the consent is bound to.

   This is the only call in the product that reports on the consent *itself* rather than
   on something derived from it. Every check built so far reads a **product** of the
   consent — a domain, a page, a record — and so can only ever report absence. If the
   authorisation never registered, or registered against a different application, or
   registered at a time that does not match when Markus consented, that is a fact no
   amount of snapshot probing could surface, and it is the last standing explanation for
   an archive that generated 42 domains but not this one.

2. **`POST /rest/memberAuthorizations` with body `{}`**, which manually enables changelog
   event generation, and the **Member Changelog API** behind it. ADR 0033 ruled the
   Changelog out with sound reasoning: a 28-day window that starts empty at consent can
   neither backfill nor survive a fortnight of downtime. That was correct **while the
   snapshot was expected to work**. It stops being correct now that the snapshot provably
   has no `MEMBER_SHARE_INFO` to give. Forward-only beats nothing.

   The docs are explicit that LinkedIn archives "all the member's interactions (posts
   created, comments, reactions etc), from the time the user has consented". Consent was
   around 10 August; the window is 28 days. So any post since then should be visible
   *right now*, and whether it is settles whether this is a usable route.

## Decision

Add both to the probe, ahead of the domain table, and generalise `dmaRequest()` out of
`probeSnapshotDomain` so any DMA endpoint gets the same headers, timeout and trace.

The probe now opens with two lines: whether the consent is registered and since when, and
how many changelog events exist with how many of them post creates.

**Both readings are three-state, not boolean.** `absent` and `quiet` are claims about
what LinkedIn *holds*, and may only be made when LinkedIn actually answered; a 401 is
`unreadable` and says nothing either way. The first draft reported "Consent: NOT
REGISTERED (HTTP 401)" against a deliberately invalid token — manufacturing a finding out
of an auth failure, which is ADR 0040's mistake in miniature and would have been read as
a discovery. Asserted in both directions by tests.

`postEvents` counts `CREATE` on share-shaped resources specifically, because "the
changelog has events" and "the changelog would carry his posts" are different questions
and only the second one decides anything. A `DELETE` on a post is not a post arriving,
and a message is not a post.

## Consequences

- **The support ticket waits on one more command.** If the consent turns out unregistered
  or bound to the wrong application, the diagnosis in ADR 0042 is incomplete and the
  remedy is different — and that is worth knowing before spending a ticket on it.
- **The Changelog API is back on the table as a real option**, and 0033's dismissal of it
  is superseded on this point. It cannot backfill, so the historical posts remain lost
  unless LinkedIn fixes the snapshot; but if it carries post creates, the archive can at
  least start growing from today rather than never. Whether to build that is a decision
  for after the probe reports, not before — the same discipline 0041 applied to the
  unfiltered crawl.
- The generalised `dmaRequest()` costs nothing and makes the next endpoint a one-liner.
  Two extra requests per probe run, both cheap, neither paginated.
- The lesson from 0039/0040/0042 recurs in a new form and is worth naming: those were
  about checks that could not come out false. This one is about a check **never run at
  all** — the product had an endpoint that spoke directly to the open question, and the
  work had been reasoning from downstream symptoms for five days without it. Re-reading
  the documentation after forming a diagnosis, rather than before, is what found it.
