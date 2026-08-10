// Two things this job must get right, neither of which shows up as a failure:
//
//   1. The re-poll must not rewrite `firstSeenAt`. The snapshot is complete on
//      every call, so every post is re-upserted every week; including
//      `firstSeenAt` in the update set would turn "when this post first appeared"
//      into "when the poller last ran" — a column that looks populated and is
//      always wrong. ADR 0013 records the same trap for `hiddenAt`.
//   2. A record with no readable post URL must be dropped, not stored with a null
//      key, because the key is the only join to the metrics.
import { describe, it, expect, vi } from 'vitest'

const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called by these pure-function tests')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { toPostRow, linkedinPostUpdateSet } = await import('./sync-linkedin-posts.js')

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
