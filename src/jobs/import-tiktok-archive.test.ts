import { describe, it, expect } from 'vitest'
import { planTiktokArchive } from './import-tiktok-archive.js'
import { objectRow } from './archive-objects.js'
import { TiktokArchiveError } from '../lib/parse-tiktok-archive.js'

const video = (id: string, postedAt: string, extra: Record<string, unknown> = {}) => ({
  postedAt,
  kind: 'video',
  id,
  url: `https://www.tiktok.com/@markusrote/video/${id}`,
  description: '#nynorsk er fint',
  views: 1000,
  likes: 100,
  comments: 10,
  shares: 1,
  durationSeconds: 12,
  sound: 'original sound - markusrote',
  location: null,
  whoCanView: 'Everyone',
  onProfile: true,
  ...extra,
})

const gone = (postedAt: string, kind: 'video' | 'photo') => ({
  postedAt,
  kind,
  id: null,
  url: null,
  description: null,
  views: null,
  likes: 5,
  comments: null,
  shares: null,
  durationSeconds: null,
  sound: null,
  location: null,
  whoCanView: 'Everyone',
  onProfile: false,
})

const file = (posts: unknown[]) => ({
  format: 'tiktok-archive/1',
  account: { username: 'markusrote', displayName: 'Markus Rote' },
  generatedAt: '2026-11-26T20:00:00Z',
  posts,
})

describe('planTiktokArchive', () => {
  it('counts what the file holds and spans first to last', () => {
    const plan = planTiktokArchive(file([
      video('7300000000000000002', '2023-11-01T10:00:00Z'),
      gone('2022-05-05T12:00:00Z', 'photo'),
      video('7052580526875495686', '2022-01-13T06:54:26Z'),
      gone('2023-03-01T18:00:00Z', 'video'),
    ]))
    expect(plan.actor.handle).toBe('@markusrote@tiktok.com')
    expect(plan.generatedAt).toBe('2026-11-26T20:00:00.000Z')
    expect(plan.stats).toEqual({
      inFile: 4,
      posts: 4,
      videos: 3,
      photos: 1,
      onProfile: 2,
      offProfile: 2,
      first: '2022-01-13T06:54:26.000Z',
      last: '2023-11-01T10:00:00.000Z',
    })
    expect(plan.problems).toEqual([])
  })

  it('refuses a second post with the same ap_id instead of overwriting the first', () => {
    const plan = planTiktokArchive(file([
      gone('2022-05-05T12:00:00Z', 'photo'),
      { ...video('1', '2022-01-01T00:00:00Z'), kind: 'nope' },
      gone('2022-05-05T12:00:00Z', 'video'),
    ]))
    expect(plan.posts).toHaveLength(1)
    expect(plan.stats.inFile).toBe(3)
    expect(plan.problems.map((p) => p.index)).toEqual([1, 2])
    expect(plan.problems[1]!.reason).toMatch(/same ap_id as post 0/)
  })

  it('throws on a file that is not a TikTok archive, so nothing is written', () => {
    expect(() => planTiktokArchive({ format: 'something-else' })).toThrow(TiktokArchiveError)
  })
})

describe('objectRow for a TikTok post', () => {
  it('fills the columns every post tool reads', () => {
    const [post] = planTiktokArchive(file([video('7052580526875495686', '2022-01-13T06:54:26Z')])).posts
    const row = objectRow('https://www.tiktok.com/@markusrote', post!)
    expect(row).toMatchObject({
      apId: 'https://www.tiktok.com/@markusrote/video/7052580526875495686',
      type: 'Video',
      actorApId: 'https://www.tiktok.com/@markusrote',
      contentText: '#nynorsk er fint',
      url: 'https://www.tiktok.com/@markusrote/video/7052580526875495686',
      inReplyTo: null,
      sensitive: false,
      language: null,
    })
    expect(row.publishedAt.toISOString()).toBe('2022-01-13T06:54:26.000Z')
    expect(row.tags).toEqual([{ type: 'Hashtag', href: 'https://www.tiktok.com/tag/nynorsk', name: '#nynorsk' }])
    expect(row.attachments).toEqual([])
    expect(row.raw).toBe(post!.object)
  })

  it('leaves url null for a post TikTok no longer shows', () => {
    const [post] = planTiktokArchive(file([gone('2022-05-05T12:00:00Z', 'photo')])).posts
    const row = objectRow('https://www.tiktok.com/@markusrote', post!)
    expect(row.apId).toBe('https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z')
    expect(row.url).toBeNull()
    expect(row.type).toBe('Image')
    expect(row.contentText).toBe('')
  })
})
