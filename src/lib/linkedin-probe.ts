import { toPostRow } from '../jobs/sync-linkedin-posts.js'
import type { DmaTrace, SnapshotTrace } from './fetch-linkedin-snapshot.js'

/**
 * Reading a set of raw snapshot responses as a diagnosis.
 *
 * Kept out of `scripts/probe-linkedin-snapshot.ts` so the part that decides which
 * stage is failing can be tested, rather than being prose in a script nobody runs
 * until something is already wrong. The script is the I/O around this.
 *
 * See ADR 0039.
 */

/**
 * The domains probed by default, and why it is a set rather than the one that
 * matters.
 *
 * A single domain answering 404 has four plausible explanations — wrong scope,
 * wrong app, a uniquely broken domain, or a collation job that has not finished —
 * and one response cannot separate them. A set can, and *which* set matters:
 *
 *  - The **controls** are profile-shaped. They answer earliest, so their answering
 *    proves the token, the scope, the consent and the archive's existence.
 *  - The **peers** are the other activity-shaped domains — the ones that were 404
 *    alongside `MEMBER_SHARE_INFO` in ADR 0034's probe. They are the load-bearing
 *    ones, because they are what "not collated yet" is a claim *about*. A peer
 *    returning data disproves it outright; the controls cannot, and reading only
 *    the controls is exactly how that hypothesis survived five days too long
 *    (ADR 0040).
 */
export const CONTROL_DOMAINS = ['PROFILE', 'REGISTRATION', 'RICH_MEDIA']
export const TARGET_DOMAIN = 'MEMBER_SHARE_INFO'
export const ACTIVITY_DOMAINS = ['ARTICLES', 'ALL_LIKES', 'ALL_COMMENTS', 'INSTANT_REPOSTS']
export const DEFAULT_DOMAINS = [...CONTROL_DOMAINS, TARGET_DOMAIN, ...ACTIVITY_DOMAINS]

/** Every documented domain, for `--all`. Case-sensitive, as LinkedIn insists. */
export const ALL_DOMAINS = [
  'ACCOUNT_HISTORY', 'ACTOR_SAVE_ITEM', 'ADS_CLICKED', 'ADS_LAN', 'AD_TARGETING',
  'ALL_COMMENTS', 'ALL_LIKES', 'ALL_VOTES', 'ARTICLES', 'CAUSES_YOU_CARE_ABOUT',
  'CERTIFICATIONS', 'COMPANY_FOLLOWS', 'CONNECTIONS', 'CONTACTS', 'COURSES',
  'EASYAPPLY_BLOCKING', 'EDUCATION', 'EMAIL_ADDRESSES', 'ENDORSEMENTS', 'EVENTS',
  'GROUPS', 'HONORS', 'IDENTITY_CREDENTIALS_AND_ASSETS', 'INBOX', 'INFERENCE_TAKEOUT',
  'INSTANT_REPOSTS', 'INVITATIONS', 'JOB_APPLICANT_SAVED_ANSWERS', 'JOB_APPLICATIONS',
  'JOB_POSTINGS', 'JOB_SEEKER_PREFERENCES', 'LANGUAGES', 'LEARNING',
  'LEARNING_COACH_AI_TAKEOUT', 'LEARNING_COACH_INBOX', 'LEARNING_ROLEPLAY_INBOX',
  'LOGIN', 'MARKETPLACE_ENGAGEMENTS', 'MARKETPLACE_OPPORTUNITIES', 'MARKETPLACE_PROVIDERS',
  'MEMBER_FOLLOWING', 'MEMBER_SHARE_INFO', 'ORGANIZATIONS', 'PATENTS', 'PHONE_NUMBERS',
  'POSITIONS', 'PROFILE', 'PROFILE_SUMMARY', 'PROJECTS', 'PUBLICATIONS', 'RECEIPTS',
  'RECEIPTS_LBP', 'RECOMMENDATIONS', 'REGISTRATION', 'REVIEWS', 'RICH_MEDIA',
  'SAVED_JOBS', 'SAVED_JOB_ALERTS', 'SEARCHES', 'SECURITY_CHALLENGE_PIPE', 'SKILLS',
  'TALENT_QUESTION_SAVED_RESPONSE', 'TEST_SCORES', 'TRUSTED_GRAPH',
  'VOLUNTEERING_EXPERIENCES',
  // Not in LinkedIn's published domain table; observed answering in a real walk on
  // 2026-08-15. The list is documentation plus what the archive actually returned,
  // because the documentation is demonstrably not exhaustive. See ADR 0042.
  'WHATSAPP_NUMBERS', 'MEMBER_HASHTAG',
]

const NO_DATA_RE = /no data found/i

/**
 * How many distinct domains a walk must have produced before its silence about one
 * of them counts as evidence.
 *
 * A walk cut short after two pages proves nothing. A real one on this archive
 * returned records for 42 domains — profile, activity, messaging, ads, the lot —
 * which is comprehensive enough that a domain missing from it is missing from the
 * archive. Set well below 42 so a smaller account still clears it, and well above a
 * handful so a truncated run does not.
 */
const WALK_COVERAGE_FLOOR = 15

export type ProbeVerdict = 'data' | 'no_data' | 'unauthorized' | 'version' | 'error' | 'unreadable'

export interface Probe {
  /** The domain that was ASKED for. Null on an all-domain query. */
  domain: string | null
  /**
   * The domain LinkedIn said it answered with, from `elements[0].snapshotDomain`.
   *
   * The two differ on an all-domain query (`q=criteria` with no `domain`), which
   * paginates across every domain in turn and is therefore the only way to see
   * which domains the archive actually holds. That matters here: a domain can 404
   * when asked for by name, and the question of whether its data exists at all is
   * a different one. See ADR 0041.
   */
  snapshotDomain: string | null
  status: number
  /** How the poller's classifier would read this response. */
  verdict: ProbeVerdict
  items: number
  /** Post keys the poller would derive — only meaningful for share-shaped domains. */
  keys: string[]
  /** LinkedIn's own request id. Quote it in a DMA support ticket. */
  requestId: string | null
  durationMs: number
  body: string
}

/**
 * One response, read the way the poller reads it.
 *
 * Same order as `fetchSnapshotPage`, no-data before status, because the
 * end-of-data terminator arrives AS a 404 — reading status first would report the
 * natural end of every successful crawl as a failure.
 */
export function classify(trace: SnapshotTrace): Probe {
  const base = {
    domain: trace.domain,
    snapshotDomain: null as string | null,
    status: trace.status,
    requestId: trace.headers['x-li-uuid'] ?? null,
    durationMs: trace.durationMs,
    body: trace.body,
    keys: [] as string[],
  }

  if (NO_DATA_RE.test(trace.body)) return { ...base, verdict: 'no_data', items: 0 }
  if (trace.status === 401 || trace.status === 403) {
    return { ...base, verdict: 'unauthorized', items: 0 }
  }
  if (trace.status === 426) return { ...base, verdict: 'version', items: 0 }
  if (trace.status < 200 || trace.status >= 300) return { ...base, verdict: 'error', items: 0 }

  let parsed: any
  try {
    parsed = JSON.parse(trace.body)
  } catch {
    return { ...base, verdict: 'unreadable', items: 0 }
  }

  const snapshotDomain: string | null = parsed?.elements?.[0]?.snapshotDomain ?? null
  const items = parsed?.elements?.[0]?.snapshotData
  if (!Array.isArray(items) || items.length === 0) {
    return { ...base, snapshotDomain, verdict: 'no_data', items: 0 }
  }

  // The keys the poller would derive. Reported because "did anything arrive" and
  // "would it have joined anything" are different questions, and the second is the
  // one that silently returns nothing.
  const keys = items
    .map((e: Record<string, unknown>) => toPostRow(e)?.postKey)
    .filter((k: string | undefined): k is string => Boolean(k))

  return { ...base, snapshotDomain, verdict: 'data', items: items.length, keys }
}

/**
 * How many pages the response says there are, or null.
 *
 * `paging.total` under-reports for a single domain — the docs say so, and ADR 0033
 * is emphatic that it must never terminate a crawl. It is used here for a different
 * job: telling a human roughly how far an all-domain walk has to go. A hint on a
 * progress line can be wrong; a loop terminator cannot.
 */
export function pagingTotal(probe: Probe): number | null {
  try {
    const n = JSON.parse(probe.body)?.paging?.total
    return typeof n === 'number' ? n : null
  } catch {
    return null
  }
}

/**
 * Documented domains that never appeared in a run.
 *
 * Printed after a walk because the unfiltered query's coverage is **not documented**,
 * and should not be assumed total: "did not appear in this walk" and "is not in the
 * archive" are different claims, and only the first is observed. Listing what was
 * never seen keeps that distinction in front of whoever reads the tally — including
 * when a domain that answers perfectly well by name is absent from the walk, which
 * would otherwise look like evidence of something it is not. See ADR 0042.
 */
export function unseenDomains(probes: Probe[]): string[] {
  // Case-folded on both sides. The domain is case-SENSITIVE on the way in — LinkedIn
  // says so and returns nothing on the wrong case — but it does not echo the same
  // spelling on the way out: a real walk answered `login` and `Events` for the
  // domains documented as `LOGIN` and `EVENTS`. Comparing verbatim would report two
  // domains as never seen while their records sat in the tally above. See ADR 0042.
  const seen = new Set([...tallyByDomain(probes).keys()].map((d) => d.toLowerCase()))
  return ALL_DOMAINS.filter((d) => !seen.has(d.toLowerCase()))
}

/** Records seen per domain across a run, keyed by what LinkedIn said it answered with. */
export function tallyByDomain(probes: Probe[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of probes) {
    const d = p.snapshotDomain ?? p.domain
    if (!d || p.verdict !== 'data') continue
    out.set(d, (out.get(d) ?? 0) + p.items)
  }
  return out
}

/**
 * Which stage is failing — auth and consent, fetch, or parse and join.
 *
 * Ordered by what would make every other reading moot: a refused token explains
 * every 404 below it, and a 426 means no request in the run was well-formed.
 */
export function verdictLine(probes: Probe[]): string {
  const named = (d: string | null) => probes.find((p) => p.domain === d)
  const has = (d: string) =>
    probes.some((p) => (p.domain === d || p.snapshotDomain === d) && p.verdict === 'data')

  // An all-domain walk that yields a MEMBER_SHARE_INFO page is the target answering,
  // even though nothing asked for it by name — and it is the more interesting way to
  // get an answer, because the per-domain query 404s. Preferred over the named probe
  // when it carries data. See ADR 0041.
  const viaWalk = probes.find(
    (p) => p.domain === null && p.snapshotDomain === TARGET_DOMAIN && p.verdict === 'data',
  )
  const target = viaWalk ?? named(TARGET_DOMAIN)

  /** Domains the unfiltered walk actually produced records for. */
  const walkedDomains = new Set(
    probes
      .filter((p) => p.domain === null && p.verdict === 'data' && p.snapshotDomain)
      .map((p) => p.snapshotDomain as string),
  )

  if (probes.some((p) => p.verdict === 'unauthorized')) {
    return 'VERDICT: auth. The token is refused (401/403). Re-mint it — this is not a collation delay.'
  }
  if (probes.some((p) => p.verdict === 'version')) {
    return 'VERDICT: fetch. A 426 means Linkedin-Version is not 202312, which is the only value this endpoint accepts.'
  }
  // A walk that produced records for many domains and never once produced the target
  // is not "the target was not probed" — it is the archive answering, comprehensively,
  // that it does not hold that domain. Stated before the not-probed fallback, which
  // would otherwise throw away the strongest evidence this tool can gather.
  if (!target?.items && walkedDomains.size >= WALK_COVERAGE_FLOOR) {
    return (
      `VERDICT: ABSENT FROM THE ARCHIVE — the unfiltered walk returned records for ` +
      `${walkedDomains.size} domains and ${TARGET_DOMAIN} was not among them. Asking for it by name ` +
      '404s and asking for everything does not produce it either, so there is no route to this data ' +
      'and no workaround to build. LinkedIn has not generated it. Report it via the DMA support form ' +
      '(https://www.linkedin.com/help/linkedin/ask/dsapi) with an x-li-uuid from this run.'
    )
  }
  if (!target) return `VERDICT: (${TARGET_DOMAIN} was not probed in this run.)`

  if (target.verdict === 'data') {
    if (viaWalk) {
      const keys = target.keys.length
      return (
        `VERDICT: WORKAROUND FOUND — the all-domain query returned a ${TARGET_DOMAIN} page ` +
        `(${target.items} record(s), ${keys} usable key(s)) even though asking for that domain by name ` +
        '404s. The data exists and is reachable; the per-domain lookup is what is broken. Worth ' +
        'teaching the poller to crawl without a domain filter, and worth saying in the support ticket.'
      )
    }
    return target.keys.length === 0
      ? 'VERDICT: parse. MEMBER_SHARE_INFO returned records but no post key could be read from any of them — ' +
          'the URL field is spelled differently than the alias list expects. Compare a raw record below against toPostRow().'
      : `VERDICT: fetch and parse are both fine — ${target.items} record(s), ${target.keys.length} usable key(s). ` +
          'If the archive is still empty, the failure is downstream of here.'
  }

  // Checked BEFORE the controls. A profile-shaped domain answering only proves the
  // archive exists; a *peer activity* domain answering proves LinkedIn has finished
  // collating activity data for this member, which is the exact claim
  // "not collated yet" rests on. See ADR 0040 — this is the reading that was wrong.
  const peers = ACTIVITY_DOMAINS.filter(has)
  if (peers.length > 0) {
    return (
      `VERDICT: upstream and STUCK, not a wait — ${peers.join(', ')} returned data, so LinkedIn has ` +
      'finished collating activity data for this member and MEMBER_SHARE_INFO alone is missing. Waiting ' +
      'longer will not fix it and re-minting cannot (the token is demonstrably good). This is the DMA ' +
      'support form: https://www.linkedin.com/help/linkedin/ask/dsapi — quote the x-li-uuid below.'
    )
  }
  if (CONTROL_DOMAINS.some(has)) {
    return (
      'VERDICT: neither auth nor fetch — the profile-shaped domains answer with data while every ' +
      'activity-shaped one does not. The token, scope and consent are good and LinkedIn has not collated ' +
      'the activity domains yet. Do NOT re-mint the token: the snapshot is built at the moment of consent, ' +
      'so re-consenting can restart the clock. Re-run this in a few hours; if a peer activity domain ' +
      'answers and MEMBER_SHARE_INFO still does not, it is stuck rather than slow.'
    )
  }
  // Only claim the controls were silent if the controls were actually asked. A run of
  // `--domain MEMBER_SHARE_INFO` alone printed "no domain returned anything, controls
  // included" having probed no control at all — asserting the very thing that makes
  // the sentence worth saying. Same disease as ADR 0040's, one branch further down.
  const controlsProbed = CONTROL_DOMAINS.filter((d) => named(d))
  if (controlsProbed.length === 0) {
    return (
      `VERDICT: inconclusive — only ${target.domain ?? 'one domain'} was probed and it returned nothing. ` +
      'That alone cannot separate a refused token from an uncollated domain from a missing archive. ' +
      'Run `npm run probe-linkedin` with no --domain for the full set.'
    )
  }
  return (
    `VERDICT: no domain returned anything — ${controlsProbed.length} control(s) included — and nothing ` +
    'was refused. The archive does not exist rather than being late; past a day of this, use the DMA ' +
    'support form.'
  )
}

// ---------------------------------------------------------------------------
// The two endpoints the snapshot work never touched. See ADR 0043.
// ---------------------------------------------------------------------------

/**
 * What `memberAuthorizations?q=memberAndApplication` says about the consent.
 *
 * This is the only call that reports on the consent ITSELF rather than on data
 * derived from it. `regulatedAt` is the moment LinkedIn began monitoring and
 * archiving for this member; `scopes` should contain `DMA`. An empty `elements`
 * array means the authorisation never registered at all — the last standing
 * explanation for a partially-generated archive, and one nothing built so far could
 * see, because every other check reads a *product* of the consent and can only
 * report its absence.
 */
export interface AuthorizationState {
  status: number
  /**
   * Three states, not a boolean.
   *
   * `absent` is a claim about LinkedIn's records and may only be made when LinkedIn
   * actually answered: a 401 says the token was refused and says nothing whatever
   * about whether a consent exists. Collapsing those two into `registered: false`
   * would manufacture a finding out of an auth failure — the same shape of mistake
   * as ADR 0040's, where a check was read as evidence for something it could not
   * test.
   */
  state: 'registered' | 'absent' | 'unreadable'
  regulatedAt: Date | null
  scopes: string[]
  /** The developer application the consent is bound to, as a URN. */
  application: string | null
}

export function readAuthorization(trace: DmaTrace): AuthorizationState {
  const ok = trace.status >= 200 && trace.status < 300
  const base: AuthorizationState = {
    status: trace.status,
    state: ok ? 'absent' : 'unreadable',
    regulatedAt: null,
    scopes: [],
    application: null,
  }

  let parsed: any
  try {
    parsed = JSON.parse(trace.body)
  } catch {
    return { ...base, state: 'unreadable' }
  }

  const el = parsed?.elements?.[0]
  if (!el) return base

  const ms = el.regulatedAt
  return {
    status: trace.status,
    state: 'registered',
    // Epoch milliseconds. Guarded rather than trusted: a zero or a string here would
    // otherwise render as 1970 and read as a real answer.
    regulatedAt: typeof ms === 'number' && ms > 0 ? new Date(ms) : null,
    scopes: Array.isArray(el.memberComplianceScopes) ? el.memberComplianceScopes : [],
    application: el.memberComplianceAuthorizationKey?.developerApplication ?? null,
  }
}

/**
 * What the changelog holds — the other route to post content this product offers.
 *
 * ADR 0033 ruled the Changelog API out: a 28-day window that starts empty at consent
 * can neither backfill nor survive downtime. That was right while the snapshot was
 * expected to arrive. It stops being right once the snapshot provably has no
 * `MEMBER_SHARE_INFO` to give, because forward-only beats nothing at all.
 *
 * `postEvents` counts CREATEs on share-shaped resources. It is the number that says
 * whether this route would actually carry his posts, as opposed to only his messages
 * and reactions.
 */
export interface ChangelogState {
  status: number
  /** `quiet` only when LinkedIn answered; a refused token is `unreadable`. */
  state: 'events' | 'quiet' | 'unreadable'
  /**
   * True when the caller stopped paging before the changelog ran out.
   *
   * The first version of this reported `0 post create(s)` from a single `count=10`
   * request and read as a survey of the 28-day window. It was the ten OLDEST events
   * in it. "No posts in the changelog" and "no posts in the first ten events" are
   * different claims and only the second was observed — so a partial read now says
   * so, and `postEvents` is never quoted as a finding without it.
   */
  truncated: boolean
  events: number
  /** Distinct `resourceName` values seen, with counts. */
  resources: Map<string, number>
  postEvents: number
  oldest: Date | null
  newest: Date | null
}

/**
 * Fold a page of changelog events into a running total.
 *
 * The changelog pages by `startTime` rather than by index, and the docs say to use
 * the previous response's latest `processedAt` — so accumulating is the caller's job
 * and this is where the pages meet.
 */
export function mergeChangelog(a: ChangelogState, b: ChangelogState): ChangelogState {
  if (a.state === 'unreadable' || a.events === 0) return { ...b, truncated: b.truncated }
  if (b.state !== 'events') return a

  const resources = new Map(a.resources)
  for (const [name, n] of b.resources) resources.set(name, (resources.get(name) ?? 0) + n)

  const times = [a.oldest, a.newest, b.oldest, b.newest].filter((d): d is Date => d !== null)
  return {
    status: b.status,
    state: 'events',
    truncated: b.truncated,
    events: a.events + b.events,
    resources,
    postEvents: a.postEvents + b.postEvents,
    oldest: times.length > 0 ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    newest: times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
  }
}

/** The `processedAt` to hand the next request, per the docs' own pagination advice. */
export function nextChangelogStart(trace: DmaTrace): number | null {
  try {
    const elements = JSON.parse(trace.body)?.elements
    if (!Array.isArray(elements) || elements.length === 0) return null
    const times = elements
      .map((e: any) => e?.processedAt)
      .filter((t: unknown): t is number => typeof t === 'number' && t > 0)
    return times.length > 0 ? Math.max(...times) : null
  } catch {
    return null
  }
}

/** Resource names that mean "a post", however LinkedIn spells them. */
const POST_RESOURCE_RE = /(ugcPosts?|shares?|posts?)$/i

export function readChangelog(trace: DmaTrace): ChangelogState {
  const ok = trace.status >= 200 && trace.status < 300
  const empty: ChangelogState = {
    status: trace.status,
    state: ok ? 'quiet' : 'unreadable',
    truncated: false,
    events: 0,
    resources: new Map(),
    postEvents: 0,
    oldest: null,
    newest: null,
  }

  let parsed: any
  try {
    parsed = JSON.parse(trace.body)
  } catch {
    return { ...empty, state: 'unreadable' }
  }

  const elements = parsed?.elements
  if (!Array.isArray(elements) || elements.length === 0) return empty

  const resources = new Map<string, number>()
  let postEvents = 0
  const times: number[] = []

  for (const e of elements) {
    const name = typeof e?.resourceName === 'string' ? e.resourceName : '(unnamed)'
    resources.set(name, (resources.get(name) ?? 0) + 1)
    if (POST_RESOURCE_RE.test(name) && e?.method === 'CREATE') postEvents++
    // capturedAt is the documented one to use for "when did this happen" — the docs
    // warn that some activities carry no created/lastModified time of their own.
    if (typeof e?.capturedAt === 'number' && e.capturedAt > 0) times.push(e.capturedAt)
  }

  return {
    status: trace.status,
    state: 'events',
    truncated: false,
    events: elements.length,
    resources,
    postEvents,
    oldest: times.length > 0 ? new Date(Math.min(...times)) : null,
    newest: times.length > 0 ? new Date(Math.max(...times)) : null,
  }
}
