# 0040 — The wait was over and the state still said wait: read the peers, not the controls

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (ran the probe on the box and posted the output that falsified the standing explanation) + Claude (agent decisions: recognised that the seam had moved and that both the probe's verdict and the poller's control were reading the wrong side of it, chose a peer activity domain as the discriminator, and made the inference deliberately one-sided)
- **Affects:** `src/lib/linkedin-probe.ts`, `src/jobs/sync-linkedin-posts.ts`
- **Topics:** linkedin, ingest, observability, diagnostics, data-quality

Amends [0034](0034-a-successful-empty-crawl-is-not-a-healthy-one.md) and
[0039](0039-a-clean-run-that-explains-nothing-is-not-observability.md). 0039 stands;
0034's *mechanism* stands and its *diagnosis* does not.

## Context

ADR 0039 shipped a probe. It ran, on the box, five days after the token was minted, and
its output retired the explanation both 0034 and 0039 had been carrying:

| | 3 hours in (ADR 0034) | 5 days in (this run) |
|---|---|---|
| `PROFILE`, `REGISTRATION`, `RICH_MEDIA` | 200 | 200 |
| `ALL_LIKES`, `ALL_COMMENTS`, `INSTANT_REPOSTS` | **404** | **200** — 1424, 68 and 11 records |
| `MEMBER_SHARE_INFO`, `ARTICLES` | 404 | 404 |

0034's reading was that the 404s were one seam: profile-shaped domains collate first,
activity-shaped ones follow, and the wait would clear itself. **The wait did clear
itself.** Three of the five domains that were 404 now hold data, `ALL_COMMENTS` reaching
back to 2025 — so LinkedIn's activity collation for this member has demonstrably finished.

`MEMBER_SHARE_INFO` is still 404. That is no longer "not collated yet". It is one domain
missing from a completed archive, and nothing about waiting or re-minting addresses it.

Worse, **both** things 0039 built were reading the wrong side of the seam and would have
gone on asserting the retired explanation indefinitely:

- the probe's `verdictLine` checked only `CONTROL_DOMAINS`, and printed *"the control
  domains answer with data while MEMBER_SHARE_INFO does not … LinkedIn has not collated
  the activity domains yet"* — directly contradicted by the `ALL_LIKES` row three lines
  above it in its own output;
- `classifyEmptyCrawl` probed only `PROFILE`, so every weekly run would have recorded
  *"token, scope and consent are all good; this domain is not collated yet"* forever.

The flaw is the same in both, and it is not that the control was wrong. `PROFILE`
answering proves the token, the scope, the consent and the archive's existence — all
true, all worth knowing, and all still true here. It simply cannot bear on collation,
**because profile-shaped domains are collated first**: they answer while the activity
ones are still assembling, and they go on answering long after collation has finished.
Testing the claim "the activity domains have not collated" against a domain that is not
one is not evidence. It is a statement that cannot come out false.

## Decision

Ask a **peer**: an activity-shaped domain that was 404 alongside the target in 0034's
original probe. The probe checks all four; the poller asks one (`ALL_COMMENTS` — likelier
to be non-empty for an active member than `INSTANT_REPOSTS`, and an order of magnitude
smaller than `ALL_LIKES`).

The inference is deliberately **one-sided**, because the evidence is:

- **A peer with data proves collation has completed** for this member's activity data. The
  target is then stuck, not late — actionable now, and neither waiting nor re-minting can
  help. New verdict: `stuck`, pointing at the DMA support form with the `x-li-uuid`.
- **A peer that is empty proves nothing.** A member can legitimately have no comments and
  no reposts. That is reported as inconclusive — "consistent with collation still running
  AND with the member simply having none" — rather than as a reassertion of the collation
  story. The old copy is kept only for the case where *every* activity domain is silent,
  which is 0034's actual picture, and it now says what would change the reading.

`stuck` is recorded as a **success**, not a failure: the crawl completed correctly, the
token is demonstrably good, and turning the badge red or firing the token alert would name
the wrong problem. It is logged at `error` level and stated in `last_note`, because it is
the one non-auth outcome that will never clear itself.

## Consequences

- **The action on the live outage changes.** It was "wait, and do not re-mint". It is now
  "report it": the token is provably fine, the archive is provably built, and one domain
  is provably absent from it. 0034's warning against re-minting still holds and is now
  better argued — re-consenting cannot help something that has already finished.
- **`ARTICLES` is probably not a second symptom.** It is 404 alongside the target, but a
  member who has never published a LinkedIn article legitimately has no `ARTICLES` data,
  and that is the likelier reading. If so, `MEMBER_SHARE_INFO` is a *lone* failure in a
  completed archive — which is a cleaner thing to report than a pair, and worth stating in
  the support ticket either way.
- **Nothing downstream of the fetch has been exercised yet.** The parse and the join
  remain unfalsified rather than proven, exactly as 0039 said. The probe's key-derivation
  column settles both the moment one record arrives — and the `ALL_LIKES` and
  `INSTANT_REPOSTS` payloads are mild positive evidence, since their `Link` fields carry
  percent-encoded `urn%3Ali%3Aactivity%3A` and `urn%3Ali%3AugcPost%3A` forms that
  `canonicalPostKey` already handles.
- **The general lesson, which is why this is an ADR and not a commit message.** 0039's
  whole thesis is that a state which cannot come out false is not observability. The
  control-domain probe it shipped to fix that had the same defect one level down: it
  produced positive evidence for a claim it could not test, and read as confirmation. A
  check is only worth its request if there is an answer it could give that would change
  the conclusion — so the question to ask of any new one is which answer that is.
