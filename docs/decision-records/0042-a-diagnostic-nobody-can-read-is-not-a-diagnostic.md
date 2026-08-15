# 0042 — A diagnostic nobody can read is not a diagnostic: the summary is the output

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (ran the 60-page walk and reported that the output was larger than his clipboard could hold) + Claude (agent decisions: suppressed raw bodies on a walk, printed the summary at both ends, added the not-seen list, and turned a comprehensive walk's silence about a domain into a stated verdict rather than a shrug)
- **Affects:** `src/lib/linkedin-probe.ts`, `scripts/probe-linkedin-snapshot.ts`
- **Topics:** linkedin, diagnostics, observability

Extends [0041](0041-ask-the-archive-what-it-holds-not-whether-a-name-answers.md).

## Context

ADR 0041 added `--pages N` so the unfiltered snapshot query could be walked. Run for
real — `--no-domain --pages 60` — it produced several hundred kilobytes: LinkedIn's
`INBOX` alone returns ~740 kB per page, `CONNECTIONS` ~137 kB, and the walk prints every
one of them. The per-domain tally, which is the entire reason to walk, was printed
*before* that flood and scrolled out of reach. It could not be read on the terminal and
could not be copied out of it.

The body-suppression rule 0041 shipped only omitted **empty** pages. On this walk almost
every page had data, so it omitted nothing.

This is the same mistake as ADR 0039's, in a different costume. There, a state was
recorded that could not distinguish the situations it covered. Here, the answer was
computed correctly and then buried under its own evidence. A diagnostic that produces the
right conclusion in a form nobody can get at has not produced it.

## Decision

**On a walk, the summary is the output and the bodies are opt-in.**

- `pages > 1` prints no raw bodies unless `--full`, and says how many it withheld and how
  to get them (`--full`, or `--json out.json` to keep them all without reading them).
- A single-page probe still prints bodies, because there the body *is* the deliverable —
  the `404 No data found` envelope is the whole finding.
- When bodies do get printed, the tally and verdict are printed **again** after them. The
  first copy is where a reader looks; the second is what survives when the bodies scrolled
  the first one away.

**And the tally settled 0041's open question outright.** The 60-page walk produced records
for **42 domains** — `ALL_LIKES` 4278, `INBOX` 3984, `ADS_CLICKED` 3780, `CONNECTIONS`
1950, down to single records for `PROFILE`, `REGISTRATION` and `COURSES`. Profile,
activity, messaging, ads, learning, identity: the lot. `MEMBER_SHARE_INFO` was not among
them.

So the walk's coverage *is* comprehensive — a worry raised from the fragments, that it
might only reach part of the alphabet, is refuted by `PROFILE` and `REGISTRATION` both
appearing in it. That makes the absence load-bearing: **asking for the domain by name
404s, and asking for everything does not produce it either.** There is no route to this
data and no workaround to build. 0041's first outcome is off the table and its second is
confirmed.

The verdict line did not say that. It said `(MEMBER_SHARE_INFO was not probed in this
run.)`, because it only looked for a probe that had *requested* that domain — throwing
away the strongest evidence the tool is capable of gathering, in the one run that gathered
it. It now reports `ABSENT FROM THE ARCHIVE` when a walk covered at least 15 distinct
domains and never produced the target. Fifteen, well under the observed 42, so a smaller
account still clears it, and well above a handful, so a run cut short after two pages
still proves nothing.

The not-seen list stays regardless, because coverage being total *for this archive* is an
observation, not a guarantee.

**Two things about the domain vocabulary fell out of the same tally.** `WHATSAPP_NUMBERS`
and `MEMBER_HASHTAG` answered with records and appear nowhere in LinkedIn's published
domain table, so the list in code is now documentation *plus* what the archive actually
returned. And the walk labelled two domains `login` and `Events` where the table spells
them `LOGIN` and `EVENTS` — the domain is case-**sensitive** on the way in, and LinkedIn
does not echo the same spelling on the way out. `unseenDomains()` compares case-folded;
verbatim comparison would have reported two domains as never seen with their records
sitting in the tally directly above.

## Consequences

- The walk is now readable at the size it actually runs at, and its conclusion is the last
  thing on screen rather than the first.
- **The LinkedIn side of this feature is now blocked on LinkedIn.** Everything downstream
  is built, tested and unfalsified; the data does not exist to feed it. The DMA support
  form is the only remaining action, and it can now be made precisely: 42 domains
  generated, `MEMBER_SHARE_INFO` absent both by name and from the unfiltered query, with
  an `x-li-uuid` per request.
- The not-seen list is long by construction — most of the documented domains are ones any
  member legitimately has no data for — so it is printed as a count plus one wrapped line,
  not a table.
- `unseenDomains()` lives in the lib rather than the script, for the reason 0039 gives:
  the part that decides something should be testable, and the script should be the I/O
  around it.
- The general lesson is worth the same shelf as 0039's and 0040's. 0039: do not record a
  state that cannot come out false. 0040: do not test a claim against something that
  cannot bear on it. 0042: do not bury the answer under the evidence for it. All three are
  the same failure — output that looks like an answer without being usable as one.
