// Two things this job must get right, neither of which shows up as a failure:
//
//   1. The re-poll must not rewrite `firstSeenAt`. The snapshot is complete on
//      every call, so every post is re-upserted every week; including
//      `firstSeenAt` in the update set would turn "when this post first appeared"
//      into "when the poller last ran" — a column that looks populated and is
//      always wrong. ADR 0013 records the same trap for `hiddenAt`.
//   2. A record with no readable post URL must be dropped, not stored with a null
//      key, because the key is the only join to the metrics.
import { describe, it, expect, vi, afterEach } from 'vitest'

const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called by these pure-function tests')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { toPostRow, linkedinPostUpdateSet, classifyEmptyCrawl } = await import('./sync-linkedin-posts.js')

const NOW = new Date('2026-08-10T12:00:00Z')

const entry = (over: Record<string, unknown> = {}) => ({
  Date: '2026-05-21 08:04:13',
  ShareLink: 'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050',
  ShareCommentary: 'KI-buzzwords',
  Visibility: 'PUBLIC',
  SharedUrl: '',
  ReshareFlag: 'No',
  ...over,
})

describe('linkedinPostUpdateSet', () => {
  it('never rewrites firstSeenAt — the poller re-sees every post every run', () => {
    const row = toPostRow(entry())!
    const set = linkedinPostUpdateSet(row, NOW)

    expect(set).not.toHaveProperty('firstSeenAt')
    expect(set).not.toHaveProperty('postKey') // the conflict target, never the payload
    expect(set.lastSeenAt).toBe(NOW)
  })

  it('does refresh the fields an edit can change', () => {
    const row = toPostRow(entry({ ShareCommentary: 'redigert', Visibility: 'CONNECTIONS' }))!
    const set = linkedinPostUpdateSet(row, NOW)

    expect(set.commentary).toBe('redigert')
    expect(set.visibility).toBe('CONNECTIONS')
  })
})

describe('toPostRow', () => {
  it('reads a MEMBER_SHARE_INFO record into columns', () => {
    const row = toPostRow(entry())!

    expect(row.postKey).toBe('7462903540748034050')
    expect(row.commentary).toBe('KI-buzzwords')
    expect(row.visibility).toBe('PUBLIC')
    expect(row.isReshare).toBe(false)
    expect(row.postedAt?.toISOString()).toBe('2026-05-21T08:04:13.000Z')
  })

  it('keeps the untouched record, so an unanticipated key rename is a re-parse', () => {
    const e = entry()
    expect(toPostRow(e)!.raw).toBe(e)
  })

  it('reads the keys however LinkedIn spells them', () => {
    const row = toPostRow({
      'Share Link': 'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050',
      'Share Commentary': 'med mellomrom',
      'Shared URL': 'https://example.com/artikkel',
    })!

    expect(row.postKey).toBe('7462903540748034050')
    expect(row.commentary).toBe('med mellomrom')
    expect(row.sharedUrl).toBe('https://example.com/artikkel')
  })

  it('canonicalises the permalink form to the same key as the URN form', () => {
    const urn = toPostRow(entry())!
    const permalink = toPostRow(
      entry({
        ShareLink:
          'https://www.linkedin.com/posts/markus-mg_ki-buzzwords-ugcPost-7462903540748034050-dUyv',
      }),
    )!

    expect(permalink.postKey).toBe(urn.postKey)
  })

  it('distinguishes the attached link from the post permalink', () => {
    const row = toPostRow(entry({ SharedUrl: 'https://example.com/artikkel' }))!

    expect(row.sharedUrl).toBe('https://example.com/artikkel')
    expect(row.postUrl).toContain('urn:li:activity:7462903540748034050')
  })

  it('reads the reshare flag in both spellings', () => {
    expect(toPostRow(entry({ ReshareFlag: 'Yes' }))!.isReshare).toBe(true)
    expect(toPostRow(entry({ ReshareFlag: 'true' }))!.isReshare).toBe(true)
  })

  it('drops a record with no usable post URL rather than storing a null key', () => {
    expect(toPostRow(entry({ ShareLink: '' }))).toBeNull()
    expect(toPostRow(entry({ ShareLink: 'https://www.linkedin.com/in/markus-mg' }))).toBeNull()
    expect(toPostRow({})).toBeNull()
  })

  it('tolerates a post with no commentary — a bare link share is still a post', () => {
    const row = toPostRow(entry({ ShareCommentary: '' }))!
    expect(row.commentary).toBeNull()
    expect(row.postKey).toBe('7462903540748034050')
  })
})

// The state this source actually lived in for four days: every run completed, every
// run ingested nothing, and `token_status` said `awaiting_data` — which was derived
// purely from `last_data_at IS NULL` and therefore said nothing whatsoever about
// whether the token still worked. An empty crawl on its own cannot be classified,
// so the job asks a domain that should always answer. See ADR 0039.
describe('classifyEmptyCrawl', () => {
  const target = {
    url: 'https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=MEMBER_SHARE_INFO&start=0',
    domain: 'MEMBER_SHARE_INFO',
    start: 0,
    status: 404,
    body: '{"message":"No data found for this domain and memberId","status":404}',
    headers: {},
    durationMs: 12,
  }

  /**
   * Answers keyed by domain, so a test can say what PROFILE and ALL_COMMENTS each
   * returned. The classifier asks PROFILE first and only asks the peer when PROFILE
   * came back with data.
   */
  function replies(byDomain: Record<string, { status?: number; body: unknown }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const domain = new URL(url).searchParams.get('domain') ?? ''
      const r = byDomain[domain] ?? { status: 404, body: NO_DATA }
      const status = r.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'x',
        text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      }
    }))
  }

  const control = (body: unknown, status = 200) => replies({ PROFILE: { status, body } })

  const NO_DATA = { message: 'No data found for this domain and memberId.', status: 404 }
  const profilePage = {
    elements: [{ snapshotDomain: 'PROFILE', snapshotData: [{ 'First Name': 'Markus' }] }],
  }
  const commentsPage = {
    elements: [{ snapshotDomain: 'ALL_COMMENTS', snapshotData: [{ Message: 'hei', Date: '2026-07-03 07:23:54' }] }],
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('calls a refused token a FAILURE, not a wait', async () => {
    control({ message: 'Invalid access token', status: 401 }, 401)
    const v = await classifyEmptyCrawl('tok', target)

    // This is the whole point: previously this run recorded a clean success, so
    // the badge stayed green, `deriveTokenStatus` never saw a 401, and the latched
    // ntfy push never fired.
    expect(v.kind).toBe('auth')
    if (v.kind !== 'auth') return
    expect(v.status).toBe(401)
    expect(v.trace.status).toBe(401)
    expect(v.note).toMatch(/token is refused/i)
  })

  it('treats a 403 the same way — consent withdrawn is not a collation delay', async () => {
    control({ message: 'Not enough permissions', status: 403 }, 403)
    expect((await classifyEmptyCrawl('tok', target)).kind).toBe('auth')
  })

  it('will not reassert the collation story on a control alone', async () => {
    // PROFILE answering proves the token and the archive. It proves NOTHING about
    // collation, because profile-shaped domains are collated FIRST — they answer
    // while the activity ones are still assembling, and they go on answering long
    // after collation has finished. Reading only PROFILE is how "not collated yet"
    // survived five days past the point it was true. See ADR 0040.
    replies({ PROFILE: { body: profilePage } })
    const v = await classifyEmptyCrawl('tok', target)

    expect(v.kind).toBe('awaiting')
    expect(v.note).toContain('PROFILE')
    expect(v.note).toContain('ALL_COMMENTS')
    expect(v.note).toMatch(/does not settle it/i)
    // An empty peer is consistent with a member who simply has no comments, so the
    // note must not claim collation is the reason.
    expect(v.note).not.toMatch(/not collated yet/i)
    // The stored body is the TARGET's — it is the response being explained.
    expect(v.trace.body).toContain('No data found')
    expect(v.trace.status).toBe(404)
  })

  it('calls it STUCK when a peer activity domain has data and the target does not', async () => {
    // The reading that was actually true on 2026-08-15: ALL_LIKES, ALL_COMMENTS and
    // INSTANT_REPOSTS had all filled in while MEMBER_SHARE_INFO stayed 404. Activity
    // collation was over; one domain was missing. Waiting could not fix that, and the
    // state was still telling its reader to wait.
    replies({ PROFILE: { body: profilePage }, ALL_COMMENTS: { body: commentsPage } })
    const v = await classifyEmptyCrawl('tok', target)

    expect(v.kind).toBe('stuck')
    expect(v.note).toMatch(/FINISHED/)
    expect(v.note).toMatch(/Not a wait/i)
    expect(v.note).toMatch(/support form/i)
    // Must not send the operator to the one action that could set the clock back.
    expect(v.note).not.toMatch(/re-mint(?!ing cannot)/i)
  })

  it('still asks the peer only when the control actually answered', async () => {
    // No point spending a request on a peer when the archive itself is missing.
    const fn = vi.fn(async () => ({
      ok: false, status: 404, statusText: 'x', text: async () => JSON.stringify(NO_DATA),
    }))
    vi.stubGlobal('fetch', fn)

    expect((await classifyEmptyCrawl('tok', target)).kind).toBe('empty_archive')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('separates a missing archive from one slow domain', async () => {
    control({ message: 'No data found for this domain and memberId', status: 404 }, 404)
    const v = await classifyEmptyCrawl('tok', target)

    expect(v.kind).toBe('empty_archive')
    expect(v.note).toMatch(/whole snapshot is missing/i)
  })

  it('says so rather than guessing when the control itself is broken', async () => {
    control('<html>502</html>', 502)
    const v = await classifyEmptyCrawl('tok', target)

    expect(v.kind).toBe('inconclusive')
    expect(v.note).toMatch(/inconclusive/i)
  })

  it('never puts the outcome in last_error unless it really failed', async () => {
    control(profilePage)
    const v = await classifyEmptyCrawl('tok', target)
    // `auth` is the only verdict the caller records via recordFailure; the rest
    // are successes with evidence attached.
    expect(v.kind).not.toBe('auth')
  })
})
