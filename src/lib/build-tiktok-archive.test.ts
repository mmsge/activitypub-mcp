import { describe, it, expect } from 'vitest'
import {
  accountFromInfos,
  buildTiktokArchive,
  exportDateSeconds,
  readExportPosts,
  readInfo,
  type InfoMeta,
} from './build-tiktok-archive.js'
import { parseTiktokArchive } from './parse-tiktok-archive.js'

const CDN = 'https://v16-webapp.tiktok.com/abc/video.mp4?x-expires=1700000000&x-signature=secret'

const exportEntry = (date: string, extra: Record<string, unknown> = {}) => ({
  Date: date,
  Link: CDN,
  Likes: '15100',
  Sound: 'original sound - markusrote',
  Location: '',
  WhoCanView: 'Everyone',
  AllowComments: 'Yes',
  ...extra,
})

const exportFile = (entries: unknown[]) => ({
  Post: { Posts: { VideoList: entries } },
  // Everything below must never be read.
  'Direct Message': { 'Direct Messages': { ChatHistory: { 'Chat History with x:': [{ Content: 'private' }] } } },
  Activity: { 'Search History': { SearchList: [{ SearchTerm: 'private search' }] } },
})

const info = (id: string, isoUtc: string, extra: Record<string, unknown> = {}) => ({
  id,
  timestamp: Date.parse(isoUtc) / 1000,
  description: 'BILLEGARE STRAUM 🤩 #NRK',
  view_count: 180200,
  like_count: 15123,
  comment_count: 99,
  repost_count: 1108,
  duration: 15,
  webpage_url: `https://www.tiktok.com/@markusrote/video/${id}`,
  uploader: 'markusrote',
  channel: 'Markus Rote 🌱',
  formats: [{ url: CDN }],
  http_headers: { Cookie: 'secret' },
  ...extra,
})

const build = (entries: unknown[], infos: unknown[]) => {
  const { posts, badDates } = readExportPosts(exportFile(entries))
  return buildTiktokArchive({
    exportPosts: posts,
    badDates,
    infos: infos.map(readInfo).filter((i): i is InfoMeta => !!i),
    username: 'markusrote',
    displayName: 'Markus Rote 🌱',
    generatedAt: new Date('2026-11-26T20:00:00Z'),
  })
}

describe('exportDateSeconds', () => {
  it('reads the export date as UTC', () => {
    expect(exportDateSeconds('2022-01-13 06:54:26')).toBe(Date.parse('2022-01-13T06:54:26Z') / 1000)
  })

  it('refuses any other spelling rather than guess a zone', () => {
    expect(exportDateSeconds('2022-01-13T06:54:26Z')).toBeNull()
    expect(exportDateSeconds('13.01.2022 06:54')).toBeNull()
    expect(exportDateSeconds(null)).toBeNull()
  })
})

describe('readExportPosts', () => {
  it('names where it looked when the export has no posts', () => {
    expect(() => readExportPosts({ Video: {} })).toThrow(/Post\.Posts\.VideoList/)
  })

  it('reports an entry whose date it cannot read', () => {
    const { posts, badDates } = readExportPosts(exportFile([exportEntry('2022-01-13 06:54:26'), exportEntry('i går')]))
    expect(posts).toHaveLength(1)
    expect(badDates).toEqual([{ index: 1, date: 'i går' }])
  })
})

describe('buildTiktokArchive', () => {
  it('pairs a post and its metadata on the exact second', () => {
    const { archive, report } = build(
      [exportEntry('2022-01-13 06:54:26')],
      [info('7052580526875495686', '2022-01-13T06:54:26Z')],
    )
    expect(report.matched).toBe(1)
    expect(archive.posts).toEqual([{
      postedAt: '2022-01-13T06:54:26Z',
      kind: 'video',
      id: '7052580526875495686',
      url: 'https://www.tiktok.com/@markusrote/video/7052580526875495686',
      description: 'BILLEGARE STRAUM 🤩 #NRK',
      views: 180200,
      // yt-dlp's count wins: it is from the same moment as the views.
      likes: 15123,
      comments: 99,
      shares: 1108,
      durationSeconds: 15,
      sound: 'original sound - markusrote',
      location: null,
      whoCanView: 'Everyone',
      onProfile: true,
    }])
  })

  it('does not pair a post with metadata one second away', () => {
    const { archive, report } = build(
      [exportEntry('2022-01-13 06:54:26')],
      [info('7052580526875495686', '2022-01-13T06:54:27Z')],
    )
    expect(report.matched).toBe(0)
    expect(archive.posts[0]).toMatchObject({ id: null, url: null, onProfile: false, likes: 15100 })
    expect(report.unmatchedInfos).toEqual([{ id: '7052580526875495686', postedAt: '2022-01-13T06:54:27Z' }])
  })

  it('calls a post with several image links and no metadata a photo post', () => {
    const { archive, report } = build(
      [exportEntry('2022-05-05 12:00:00', { Link: `${CDN}\n${CDN}\n${CDN}` }), exportEntry('2023-03-01 18:00:00')],
      [],
    )
    expect(report.withoutMetadata).toEqual({ photo: 1, video: 1 })
    expect(archive.posts.map((p) => p.kind)).toEqual(['photo', 'video'])
  })

  it('pairs nothing in a second two posts share, and says so', () => {
    const { archive, report } = build(
      [exportEntry('2022-01-13 06:54:26'), exportEntry('2022-01-13 06:54:26')],
      [info('7052580526875495686', '2022-01-13T06:54:26Z')],
    )
    expect(report.matched).toBe(0)
    expect(report.ambiguous).toEqual([{ postedAt: '2022-01-13T06:54:26Z', exportPosts: 2, infos: ['7052580526875495686'] }])
    expect(report.unmatchedInfos).toEqual([])
    expect(archive.posts.every((p) => p.id === null)).toBe(true)
  })

  it('takes the photo kind from yt-dlp when it found a photo post', () => {
    const { archive } = build(
      [exportEntry('2024-02-02 10:00:00')],
      [info('7330000000000000000', '2024-02-02T10:00:00Z', { webpage_url: 'https://www.tiktok.com/@markusrote/photo/7330000000000000000' })],
    )
    expect(archive.posts[0]).toMatchObject({ kind: 'photo', url: 'https://www.tiktok.com/@markusrote/photo/7330000000000000000' })
  })

  it('copies no CDN link and nothing from the rest of the export', () => {
    const { archive } = build(
      [exportEntry('2022-01-13 06:54:26'), exportEntry('2022-05-05 12:00:00', { Link: `${CDN}\n${CDN}` })],
      [info('7052580526875495686', '2022-01-13T06:54:26Z')],
    )
    const out = JSON.stringify(archive)
    expect(out).not.toContain('v16-webapp')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('private')
    expect(out).not.toContain('AllowComments')
  })

  it('writes a file the importer reads without a single problem', () => {
    const { archive } = build(
      [exportEntry('2022-01-13 06:54:26'), exportEntry('2022-05-05 12:00:00', { Link: `${CDN}\n${CDN}` }), exportEntry('2020-11-09 17:02:11')],
      [info('7052580526875495686', '2022-01-13T06:54:26Z')],
    )
    const { problems, archive: parsed } = parseTiktokArchive(JSON.parse(JSON.stringify(archive)))
    expect(problems).toEqual([])
    expect(parsed.posts.map((p) => p.postedAt)).toEqual([
      '2020-11-09T17:02:11.000Z',
      '2022-01-13T06:54:26.000Z',
      '2022-05-05T12:00:00.000Z',
    ])
  })
})

describe('accountFromInfos', () => {
  it('takes the account from the newest metadata', () => {
    const infos = [
      info('1', '2021-01-01T00:00:00Z', { uploader: 'oldname', channel: 'Old' }),
      info('2', '2025-01-01T00:00:00Z'),
    ].map(readInfo).filter((i): i is InfoMeta => !!i)
    expect(accountFromInfos(infos)).toEqual({ username: 'markusrote', displayName: 'Markus Rote 🌱' })
    expect(accountFromInfos([])).toEqual({ username: null, displayName: null })
  })

  it('does not let a sparse newest file blank the display name', () => {
    const infos = [
      info('1', '2021-01-01T00:00:00Z'),
      { id: '2', timestamp: Date.parse('2025-01-01T00:00:00Z') / 1000, uploader: 'markusrote' },
    ].map(readInfo).filter((i): i is InfoMeta => !!i)
    expect(accountFromInfos(infos)).toEqual({ username: 'markusrote', displayName: 'Markus Rote 🌱' })
  })
})
