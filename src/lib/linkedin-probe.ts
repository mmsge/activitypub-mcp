import { toPostRow } from '../jobs/sync-linkedin-posts.js'
import type { SnapshotTrace } from './fetch-linkedin-snapshot.js'

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
 * and one response cannot separate them. The seam between profile-shaped and
 * activity-shaped domains can: five simultaneous failures along one seam is one
 * upstream job that has not run, and it rules out the other three at once. That
 * seam is the evidence ADR 0034 was built on, and it took a hand-written curl loop
 * to find. This is that loop, kept.
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
]

const NO_DATA_RE = /no data found/i

export type ProbeVerdict = 'data' | 'no_data' | 'unauthorized' | 'version' | 'error' | 'unreadable'

export interface Probe {
  domain: string | null
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

  const items = parsed?.elements?.[0]?.snapshotData
  if (!Array.isArray(items) || items.length === 0) {
    return { ...base, verdict: 'no_data', items: 0 }
  }

  // The keys the poller would derive. Reported because "did anything arrive" and
  // "would it have joined anything" are different questions, and the second is the
  // one that silently returns nothing.
  const keys = items
    .map((e: Record<string, unknown>) => toPostRow(e)?.postKey)
    .filter((k: string | undefined): k is string => Boolean(k))

  return { ...base, verdict: 'data', items: items.length, keys }
}

/**
 * Which stage is failing — auth and consent, fetch, or parse and join.
 *
 * Ordered by what would make every other reading moot: a refused token explains
 * every 404 below it, and a 426 means no request in the run was well-formed.
 */
export function verdictLine(probes: Probe[]): string {
  const named = (d: string | null) => probes.find((p) => p.domain === d)
  const has = (d: string) => named(d)?.verdict === 'data'
  const target = named(TARGET_DOMAIN)

  if (probes.some((p) => p.verdict === 'unauthorized')) {
    return 'VERDICT: auth. The token is refused (401/403). Re-mint it — this is not a collation delay.'
  }
  if (probes.some((p) => p.verdict === 'version')) {
    return 'VERDICT: fetch. A 426 means Linkedin-Version is not 202312, which is the only value this endpoint accepts.'
  }
  if (!target) return 'VERDICT: (MEMBER_SHARE_INFO was not probed in this run.)'

  if (target.verdict === 'data') {
    return target.keys.length === 0
      ? 'VERDICT: parse. MEMBER_SHARE_INFO returned records but no post key could be read from any of them — ' +
          'the URL field is spelled differently than the alias list expects. Compare a raw record below against toPostRow().'
      : `VERDICT: fetch and parse are both fine — ${target.items} record(s), ${target.keys.length} usable key(s). ` +
          'If the archive is still empty, the failure is downstream of here.'
  }
  if (CONTROL_DOMAINS.some(has)) {
    return (
      'VERDICT: neither auth nor fetch — the control domains answer with data while MEMBER_SHARE_INFO does not. ' +
      'The token, scope and consent are good and LinkedIn has not collated the activity domains yet. ' +
      'Do NOT re-mint the token: the snapshot is built at the moment of consent, so re-consenting can restart the clock.'
    )
  }
  return (
    'VERDICT: no domain returned anything, controls included, and nothing was refused. ' +
    'The archive does not exist rather than being late — past a day of this, use the DMA support form.'
  )
}
