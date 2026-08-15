// The probe's job is to say WHICH STAGE is failing — auth and consent, fetch, or
// parse and join — from one pass over the domains. It is the hand-written curl loop
// from ADR 0034 turned into something runnable, and the verdict is the whole point
// of running it, so the verdict is what gets tested.
//
// Why a set of domains rather than the one that matters: a single 404 has four
// plausible explanations (wrong scope, wrong app, a uniquely broken domain, an
// unfinished collation job) and one response cannot separate them. The seam between
// the profile-shaped domains and the activity-shaped ones can. See ADR 0039.
import { describe, it, expect, vi } from 'vitest'

const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called — the probe writes nothing and reads no table')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { classify, verdictLine, tallyByDomain, pagingTotal, unseenDomains, DEFAULT_DOMAINS, ALL_DOMAINS } =
  await import('./linkedin-probe.js')

const trace = (domain: string | null, status: number, body: unknown) => ({
  url: `https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=${domain}&start=0`,
  domain,
  start: 0,
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: {} as Record<string, string>,
  durationMs: 5,
})

const NO_DATA = { message: 'No data found for this domain and memberId', status: 404 }
const shares = (items: unknown[]) => ({
  elements: [{ snapshotDomain: 'MEMBER_SHARE_INFO', snapshotData: items }],
})
const SHARE = {
  Date: '2026-05-21 08:04:13',
  ShareLink: 'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050',
  ShareCommentary: 'KI-buzzwords',
  Visibility: 'MEMBER_NETWORK',
}

describe('classify', () => {
  it('reads the no-data terminator before the status, as the poller does', () => {
    // It arrives AS a 404. Reading status first would call the natural end of every
    // successful crawl a failure.
    const p = classify(trace('MEMBER_SHARE_INFO', 404, NO_DATA))
    expect(p.verdict).toBe('no_data')
  })

  it('names a refused token rather than folding it into "no data"', () => {
    expect(classify(trace('PROFILE', 401, { message: 'Invalid access token' })).verdict)
      .toBe('unauthorized')
    expect(classify(trace('PROFILE', 403, { message: 'Not enough permissions' })).verdict)
      .toBe('unauthorized')
  })

  it('names a 426 separately — that is the pinned version, not the archive', () => {
    expect(classify(trace('PROFILE', 426, { message: 'NONEXISTENT_VERSION' })).verdict).toBe('version')
  })

  it('reports a 200 with an empty snapshotData as no data, not as data', () => {
    expect(classify(trace('MEMBER_SHARE_INFO', 200, shares([]))).verdict).toBe('no_data')
  })

  it('derives the post keys the poller would derive', () => {
    const p = classify(trace('MEMBER_SHARE_INFO', 200, shares([SHARE])))
    expect(p.verdict).toBe('data')
    expect(p.items).toBe(1)
    // "Did anything arrive" and "would it have joined" are different questions.
    expect(p.keys).toEqual(['7462903540748034050'])
  })

  it('reports records with no readable key as data with no keys', () => {
    const p = classify(trace('MEMBER_SHARE_INFO', 200, shares([{ Date: '2026-05-21 08:04:13' }])))
    expect(p.verdict).toBe('data')
    expect(p.items).toBe(1)
    expect(p.keys).toEqual([])
  })

  it('does not mistake an HTML error page for an empty archive', () => {
    expect(classify(trace('PROFILE', 200, '<html>oops</html>')).verdict).toBe('unreadable')
  })
})

describe('verdictLine', () => {
  const control = (status: number, body: unknown) => classify(trace('PROFILE', status, body))
  const target = (status: number, body: unknown) => classify(trace('MEMBER_SHARE_INFO', status, body))

  it('blames auth first — a refused token explains every 404 under it', () => {
    const line = verdictLine([control(401, { message: 'Invalid access token' }), target(404, NO_DATA)])
    expect(line).toMatch(/VERDICT: auth/)
    expect(line).toMatch(/Re-mint/)
  })

  it('blames the pinned version when anything answered 426', () => {
    expect(verdictLine([target(426, { message: 'NONEXISTENT_VERSION' })])).toMatch(/VERDICT: fetch/)
  })

  it('reads controls-only silence as collation still running', () => {
    const line = verdictLine([control(200, { elements: [{ snapshotData: [{ 'First Name': 'M' }] }] }), target(404, NO_DATA)])
    expect(line).toMatch(/neither auth nor fetch/)
    // The one action a frustrated operator is most likely to take is the one that
    // could set the clock back (ADR 0034).
    expect(line).toMatch(/Do NOT re-mint/)
    // And it must say what would change the reading, or it is unfalsifiable.
    expect(line).toMatch(/peer activity domain/)
  })

  it('calls it STUCK the moment a peer activity domain answers — this is the real 2026-08-15 run', () => {
    // Controls 200, ALL_LIKES / ALL_COMMENTS / INSTANT_REPOSTS 200 with data,
    // MEMBER_SHARE_INFO and ARTICLES 404. Activity collation had demonstrably
    // finished; the previous verdict still said "not collated yet, keep waiting",
    // which is the failure ADR 0040 records.
    const line = verdictLine([
      control(200, { elements: [{ snapshotData: [{ 'First Name': 'M' }] }] }),
      classify(trace('REGISTRATION', 200, { elements: [{ snapshotData: [{ 'Registered At': '9/27/12' }] }] })),
      target(404, NO_DATA),
      classify(trace('ARTICLES', 404, NO_DATA)),
      classify(trace('ALL_LIKES', 200, { elements: [{ snapshotData: [{ Link: 'x', Type: 'LIKE' }] }] })),
      classify(trace('ALL_COMMENTS', 200, { elements: [{ snapshotData: [{ Message: 'hei' }] }] })),
      classify(trace('INSTANT_REPOSTS', 200, { elements: [{ snapshotData: [{ Link: 'y' }] }] })),
    ])

    expect(line).toMatch(/STUCK/)
    expect(line).toMatch(/not a wait/i)
    expect(line).toMatch(/support form/i)
    expect(line).toContain('ALL_LIKES')
    expect(line).not.toMatch(/neither auth nor fetch/)
  })

  it('still blames auth first even when peers have data', () => {
    // A refused token somewhere in the run explains every 404 under it, whatever
    // else answered.
    const line = verdictLine([
      control(401, { message: 'Invalid access token' }),
      classify(trace('ALL_LIKES', 200, { elements: [{ snapshotData: [{ Link: 'x' }] }] })),
      target(404, NO_DATA),
    ])
    expect(line).toMatch(/VERDICT: auth/)
  })

  it('calls a wholly silent archive a different problem from one slow domain', () => {
    const line = verdictLine([control(404, NO_DATA), target(404, NO_DATA)])
    expect(line).toMatch(/archive does not exist/)
    expect(line).not.toMatch(/neither auth nor fetch/)
  })

  it('blames the parse when records arrive but no key can be read from them', () => {
    const line = verdictLine([target(200, shares([{ Date: '2026-05-21 08:04:13' }]))])
    expect(line).toMatch(/VERDICT: parse/)
  })

  it('clears every stage when the target returns usable records', () => {
    const line = verdictLine([target(200, shares([SHARE]))])
    expect(line).toMatch(/fetch and parse are both fine/)
    expect(line).toMatch(/1 usable key/)
  })

  it('says so rather than guessing when the target was not probed', () => {
    expect(verdictLine([control(200, { elements: [{ snapshotData: [{ a: 1 }] }] })]))
      .toMatch(/was not probed/)
  })
})

describe('the probed domain set', () => {
  it('spans the seam — controls, the target, and the other activity domains', () => {
    expect(DEFAULT_DOMAINS).toContain('PROFILE')
    expect(DEFAULT_DOMAINS).toContain('MEMBER_SHARE_INFO')
    expect(DEFAULT_DOMAINS).toContain('ALL_COMMENTS')
  })

  it('lists every domain LinkedIn documents, in the case LinkedIn documents', () => {
    expect(ALL_DOMAINS).toContain('MEMBER_SHARE_INFO')
    expect(ALL_DOMAINS).not.toContain('member_share_info')
    expect(new Set(ALL_DOMAINS).size).toBe(ALL_DOMAINS.length)
    for (const d of DEFAULT_DOMAINS) expect(ALL_DOMAINS).toContain(d)
  })
})

// The all-domain query (`q=criteria` with no `domain`) paginates across every domain
// in turn — 59 pages on this archive — so it is the only view of what the snapshot
// ACTUALLY holds, as opposed to what answers when asked for by name. Those are
// different questions the moment a named lookup 404s. See ADR 0041.
describe('the all-domain walk', () => {
  const walkPage = (domain: string, items: unknown[], total?: number) =>
    classify(trace(null, 200, {
      ...(total === undefined ? {} : { paging: { start: 0, count: 10, total } }),
      elements: [{ snapshotDomain: domain, snapshotData: items }],
    }))

  it('records what LinkedIn answered with, not what was asked for', () => {
    const p = walkPage('LOGIN', [{ 'Login Type': 'Login' }])
    expect(p.domain).toBeNull()
    expect(p.snapshotDomain).toBe('LOGIN')
  })

  it('tallies records per domain across the pages', () => {
    const tally = tallyByDomain([
      walkPage('LOGIN', [{ a: 1 }, { a: 2 }]),
      walkPage('ALL_LIKES', [{ a: 3 }]),
      walkPage('LOGIN', [{ a: 4 }]),
      walkPage('ARTICLES', []),
    ])
    expect(tally.get('LOGIN')).toBe(3)
    expect(tally.get('ALL_LIKES')).toBe(1)
    // An empty page contributes nothing rather than a zero entry that reads as
    // "this domain was seen".
    expect(tally.has('ARTICLES')).toBe(false)
  })

  it('calls a MEMBER_SHARE_INFO page in the walk a WORKAROUND, not just data', () => {
    // This is the outcome worth shouting about: the named lookup 404s while the
    // unfiltered one hands the same domain over. The data would exist and be
    // reachable, and the poller could be taught to crawl without the filter.
    const line = verdictLine([
      classify(trace('MEMBER_SHARE_INFO', 404, NO_DATA)),
      walkPage('MEMBER_SHARE_INFO', [SHARE]),
    ])
    expect(line).toMatch(/WORKAROUND FOUND/)
    expect(line).toMatch(/1 usable key/)
  })

  it('does not let a walk page mask a refused token', () => {
    const line = verdictLine([
      classify(trace('PROFILE', 401, { message: 'Invalid access token' })),
      walkPage('MEMBER_SHARE_INFO', [SHARE]),
    ])
    expect(line).toMatch(/VERDICT: auth/)
  })

  it('reads paging.total as a hint and nothing more', () => {
    expect(pagingTotal(walkPage('LOGIN', [{ a: 1 }], 59))).toBe(59)
    // Absent or unparseable is null, never 0 — a 0 would read as "no pages" and
    // ADR 0033 is emphatic this count must never terminate anything.
    expect(pagingTotal(walkPage('LOGIN', [{ a: 1 }]))).toBeNull()
    expect(pagingTotal(classify(trace(null, 200, '<html>')))).toBeNull()
  })
})

describe('unseenDomains', () => {
  const walkPage = (domain: string, items: unknown[]) =>
    classify(trace(null, 200, { elements: [{ snapshotDomain: domain, snapshotData: items }] }))

  it('lists what a walk never showed, so absence stays a claim about the walk', () => {
    // The unfiltered query's coverage is not documented. Reporting only what WAS
    // seen would let a reader slide from "absent from the walk" to "absent from the
    // archive", which are different claims and only the first is observed.
    const unseen = unseenDomains([walkPage('LOGIN', [{ a: 1 }]), walkPage('INBOX', [{ b: 2 }])])
    expect(unseen).not.toContain('LOGIN')
    expect(unseen).not.toContain('INBOX')
    expect(unseen).toContain('MEMBER_SHARE_INFO')
    expect(unseen.length).toBe(ALL_DOMAINS.length - 2)
  })

  it('counts a domain that answered by name as seen', () => {
    expect(unseenDomains([classify(trace('PROFILE', 200, {
      elements: [{ snapshotDomain: 'PROFILE', snapshotData: [{ 'First Name': 'M' }] }],
    }))])).not.toContain('PROFILE')
  })

  it('does not count a domain that answered with nothing', () => {
    expect(unseenDomains([classify(trace('ARTICLES', 404, NO_DATA))])).toContain('ARTICLES')
  })
})

// The real walk of 2026-08-15: 42 domains returned records — profile, activity,
// messaging, ads, the lot — and MEMBER_SHARE_INFO was not one of them. Asking by name
// 404s and asking for everything does not produce it either, which is as close to
// proof of absence as this API allows. The verdict said "(MEMBER_SHARE_INFO was not
// probed in this run.)" and threw that away. See ADR 0042.
describe('a completed walk that never shows the target', () => {
  const walkPage = (domain: string) =>
    classify(trace(null, 200, { elements: [{ snapshotDomain: domain, snapshotData: [{ a: 1 }] }] }))
  const wideWalk = [
    'ALL_LIKES', 'INBOX', 'ADS_CLICKED', 'CONNECTIONS', 'ENDORSEMENTS', 'INVITATIONS',
    'SECURITY_CHALLENGE_PIPE', 'LEARNING', 'COMPANY_FOLLOWS', 'RICH_MEDIA', 'ALL_COMMENTS',
    'SKILLS', 'MEMBER_FOLLOWING', 'login', 'RECEIPTS_LBP', 'POSITIONS', 'PROFILE',
  ].map(walkPage)

  it('calls it ABSENT FROM THE ARCHIVE rather than "not probed"', () => {
    const line = verdictLine(wideWalk)
    expect(line).toMatch(/ABSENT FROM THE ARCHIVE/)
    expect(line).toMatch(/no workaround to build/)
    expect(line).not.toMatch(/was not probed/)
  })

  it('holds even when the named lookup 404d alongside it', () => {
    expect(verdictLine([...wideWalk, classify(trace('MEMBER_SHARE_INFO', 404, NO_DATA))]))
      .toMatch(/ABSENT FROM THE ARCHIVE/)
  })

  it('will not conclude absence from a walk too short to mean anything', () => {
    // Two pages prove nothing. Silence has to be earned.
    expect(verdictLine([walkPage('LOGIN'), walkPage('INBOX')])).toMatch(/was not probed/)
  })

  it('still yields to a walk page that DID carry the target', () => {
    expect(verdictLine([...wideWalk, classify(trace(null, 200, {
      elements: [{ snapshotDomain: 'MEMBER_SHARE_INFO', snapshotData: [SHARE] }],
    }))])).toMatch(/WORKAROUND FOUND/)
  })

  it('still blames auth ahead of it', () => {
    expect(verdictLine([...wideWalk, classify(trace('PROFILE', 401, { message: 'nope' }))]))
      .toMatch(/VERDICT: auth/)
  })
})

describe('the domain list against what a real archive returned', () => {
  it('carries the domains LinkedIn answered with but never documented', () => {
    // The published table is not exhaustive; a real walk produced both of these.
    expect(ALL_DOMAINS).toContain('WHATSAPP_NUMBERS')
    expect(ALL_DOMAINS).toContain('MEMBER_HASHTAG')
  })

  it('does not report a domain as unseen because LinkedIn changed its case', () => {
    // The walk answered `login` and `Events` for LOGIN and EVENTS. The domain is
    // case-sensitive on the way IN; the label coming back is not the same spelling.
    const unseen = unseenDomains([
      classify(trace(null, 200, { elements: [{ snapshotDomain: 'login', snapshotData: [{ a: 1 }] }] })),
      classify(trace(null, 200, { elements: [{ snapshotDomain: 'Events', snapshotData: [{ a: 1 }] }] })),
    ])
    expect(unseen).not.toContain('LOGIN')
    expect(unseen).not.toContain('EVENTS')
  })
})
