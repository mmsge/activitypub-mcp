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

  function control(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    })))
  }

  const profilePage = {
    elements: [{ snapshotDomain: 'PROFILE', snapshotData: [{ 'First Name': 'Markus' }] }],
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

  it('confirms awaiting_data with positive evidence when the control answers', async () => {
    control(profilePage)
    const v = await classifyEmptyCrawl('tok', target)

    expect(v.kind).toBe('awaiting')
    expect(v.note).toContain('PROFILE')
    expect(v.note).toMatch(/not collated yet/i)
    // The stored body is the TARGET's — it is the response being explained.
    expect(v.trace.body).toContain('No data found')
    expect(v.trace.status).toBe(404)
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
