import { describe, it, expect } from 'vitest'
import {
  TiktokArchiveError,
  actorApId,
  actorHandle,
  archivedPostApId,
  buildTiktokActor,
  descriptionTags,
  parseTiktokArchive,
  postToObject,
  renderDescriptionHtml,
  type TiktokArchivePost,
} from './parse-tiktok-archive.js'
import { stripHtml } from './strip-html.js'

const account = { username: 'markusrote', displayName: 'Markus Rote 🌱' }
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

const video = {
  postedAt: '2022-01-13T06:54:26Z',
  kind: 'video',
  id: '7052580526875495686',
  url: 'https://www.tiktok.com/@markusrote/video/7052580526875495686',
  description: 'BILLEGARE STRAUM 🤩 #NRK #TV2 #Strøm med @gyda.no!',
  views: 180200,
  likes: 15100,
  comments: 99,
  shares: 1108,
  durationSeconds: 15,
  sound: 'original sound - markusrote',
  location: null,
  whoCanView: 'Everyone',
  onProfile: true,
}

const file = (posts: unknown[], extra: Record<string, unknown> = {}) => ({
  format: 'tiktok-archive/1',
  account,
  generatedAt: '2026-11-26T20:00:00Z',
  posts,
  ...extra,
})

const parseOne = (post: unknown) => {
  const { archive, problems } = parseTiktokArchive(file([post]))
  return { post: archive.posts[0] as TiktokArchivePost | undefined, problems }
}

describe('identity', () => {
  it('files the account on tiktok.com and its pages on www', () => {
    expect(actorApId('markusrote')).toBe('https://www.tiktok.com/@markusrote')
    expect(actorHandle('markusrote')).toBe('@markusrote@tiktok.com')
  })

  it('gives a post with no id a stable ap_id built from its second', () => {
    expect(archivedPostApId('markusrote', '2022-05-05T12:00:00.000Z')).toBe(
      'https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z',
    )
    // The same instant however it is spelled.
    expect(archivedPostApId('markusrote', '2022-05-05T14:00:00+02:00')).toBe(
      'https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z',
    )
  })
})

describe('parseTiktokArchive', () => {
  it('refuses a file that is not a tiktok-archive/1, naming the build script', () => {
    expect(() => parseTiktokArchive(file([], { format: 'tiktok-archive/2' }))).toThrow(TiktokArchiveError)
    expect(() => parseTiktokArchive({ Post: { Posts: { VideoList: [] } } })).toThrow(/build-tiktok-archive/)
    expect(() => parseTiktokArchive([])).toThrow(TiktokArchiveError)
    expect(() => parseTiktokArchive(file([], { account: { username: 'not a name' } }))).toThrow(/username/)
    expect(() => parseTiktokArchive(file([], { posts: {} }))).toThrow(/posts/)
  })

  it('keeps the good posts and lists the bad ones by position', () => {
    const { archive, problems } = parseTiktokArchive(file([video, { ...video, kind: 'reel' }, { ...video, postedAt: 'yesterday' }]))
    expect(archive.posts).toHaveLength(1)
    expect(problems.map((p) => p.index)).toEqual([1, 2])
    expect(problems[0]!.reason).toMatch(/kind/)
    expect(problems[1]!.reason).toMatch(/postedAt/)
  })

  it('refuses an id that JSON already rounded', () => {
    const { problems } = parseOne({ ...video, id: 7052580526875495686 })
    expect(problems[0]?.reason).toMatch(/id is not a string/)
  })

  it('refuses a url that is not this post on TikTok', () => {
    expect(parseOne({ ...video, url: 'https://evil.example/@markusrote/video/7052580526875495686' }).problems[0]?.reason)
      .toMatch(/not the TikTok page/)
    expect(parseOne({ ...video, url: 'https://www.tiktok.com/@markusrote/video/1' }).problems[0]?.reason)
      .toMatch(/not the TikTok page/)
    expect(parseOne({ ...video, id: null }).problems[0]?.reason).toMatch(/url without an id/)
  })

  it('stores the canonical page for an id, whatever query the url carried', () => {
    const { post } = parseOne({ ...video, url: `${video.url}?is_from_webapp=1` })
    expect(post?.url).toBe(video.url)
  })

  it('refuses a negative or fractional count', () => {
    expect(parseOne({ ...video, views: -1 }).problems[0]?.reason).toMatch(/views/)
    expect(parseOne({ ...video, likes: 1.5 }).problems[0]?.reason).toMatch(/likes/)
  })
})

describe('renderDescriptionHtml', () => {
  it('links hashtags and mentions the way Mastodon does, and strips back to the words', () => {
    const html = renderDescriptionHtml(video.description)
    expect(html).toContain('<a href="https://www.tiktok.com/tag/Str%C3%B8m" class="mention hashtag" rel="tag">#<span>Strøm</span></a>')
    expect(html).toContain('<a href="https://www.tiktok.com/@gyda.no" class="u-url mention"')
    expect(stripHtml(html)).toBe('BILLEGARE STRAUM 🤩 #NRK #TV2 #Strøm med @gyda.no!')
  })

  it('leaves e-mail addresses, URL fragments and a lone @ as text', () => {
    const html = renderDescriptionHtml('skriv til a@b.no eller sjå x.no/#topp, @ deg')
    expect(html).not.toContain('<a')
  })

  it('keeps the full stop after a mention outside the link', () => {
    const html = renderDescriptionHtml('takk til @nrk.')
    expect(html).toMatch(/@<span>nrk<\/span><\/a><\/span>\.<\/p>$/)
  })

  it('escapes the caption and keeps its line breaks', () => {
    expect(renderDescriptionHtml('a <b> & c\nd\n\ne')).toBe('<p>a &lt;b&gt; &amp; c<br>d</p><p>e</p>')
    expect(renderDescriptionHtml(null)).toBe('')
    expect(renderDescriptionHtml('  ')).toBe('')
  })
})

describe('descriptionTags', () => {
  it('lists each hashtag once, whatever its case, and each mention once', () => {
    const tags = descriptionTags('#NRK #nrk #Nynorsk @gyda.no @Gyda.no')
    expect(tags).toEqual([
      { type: 'Hashtag', href: 'https://www.tiktok.com/tag/NRK', name: '#NRK' },
      { type: 'Hashtag', href: 'https://www.tiktok.com/tag/Nynorsk', name: '#Nynorsk' },
      { type: 'Mention', href: 'https://www.tiktok.com/@gyda.no', name: '@gyda.no@tiktok.com' },
    ])
  })
})

describe('postToObject', () => {
  it('maps a video on the profile to a public Video at its own page', () => {
    const { post } = parseOne(video)
    const built = postToObject(post!, account)
    expect(built.type).toBe('Video')
    expect(built.apId).toBe(video.url)
    const o = built.object
    expect(o.id).toBe(video.url)
    expect(o.url).toBe(video.url)
    expect(o.attributedTo).toBe('https://www.tiktok.com/@markusrote')
    expect(o.published).toBe('2022-01-13T06:54:26.000Z')
    expect(o.to).toEqual([PUBLIC])
    expect(o.cc).toEqual(['https://www.tiktok.com/@gyda.no'])
    expect(o.duration).toBe('PT15S')
    expect(o.likes).toEqual({ type: 'Collection', totalItems: 15100 })
    expect(o.shares).toEqual({ type: 'Collection', totalItems: 1108 })
    expect(o.replies).toEqual({ type: 'Collection', totalItems: 99 })
    expect((o.tag as unknown[]).length).toBe(4)
    // The post rides along whole: views and the sound are read from here.
    expect(o.tiktokArchive).toEqual({ username: 'markusrote', post })
    expect(((o.tiktokArchive as { post: TiktokArchivePost }).post).views).toBe(180200)
  })

  it('maps a duet like any other video: no inReplyTo to a video that is not stored', () => {
    const { post } = parseOne({ ...video, description: '#duet with @someone ha!', id: '7100000000000000001', url: null })
    const o = postToObject(post!, account).object
    expect(o.type).toBe('Video')
    expect(o).not.toHaveProperty('inReplyTo')
    expect(o.url).toBe('https://www.tiktok.com/@markusrote/video/7100000000000000001')
    expect(o.tag).toEqual([
      { type: 'Hashtag', href: 'https://www.tiktok.com/tag/duet', name: '#duet' },
      { type: 'Mention', href: 'https://www.tiktok.com/@someone', name: '@someone@tiktok.com' },
    ])
  })

  it('maps a photo post with no metadata to an Image with a synthetic ap_id and no url', () => {
    const { post } = parseOne({
      postedAt: '2022-05-05T12:00:00Z',
      kind: 'photo',
      id: null,
      url: null,
      description: null,
      views: null,
      likes: 312,
      comments: null,
      shares: null,
      durationSeconds: null,
      sound: 'original sound - markusrote',
      location: null,
      whoCanView: 'Everyone',
      onProfile: false,
    })
    const built = postToObject(post!, account)
    expect(built.type).toBe('Image')
    expect(built.apId).toBe('https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z')
    expect(built.object).not.toHaveProperty('url')
    expect(built.object.content).toBe('')
    expect(built.object).not.toHaveProperty('tag')
    expect(built.object.likes).toEqual({ type: 'Collection', totalItems: 312 })
    expect(built.object).not.toHaveProperty('replies')
    expect(built.object).not.toHaveProperty('duration')
  })

  it('maps a video no longer on the profile to a Video with no url', () => {
    const { post } = parseOne({
      ...video,
      postedAt: '2023-03-01T18:00:00Z',
      id: null,
      url: null,
      description: null,
      views: null,
      comments: null,
      shares: null,
      durationSeconds: null,
      likes: 40,
      onProfile: false,
    })
    const built = postToObject(post!, account)
    expect(built.type).toBe('Video')
    expect(built.apId).toBe('https://www.tiktok.com/@markusrote#arkiv-20230301T180000Z')
    expect(built.object).not.toHaveProperty('url')
  })

  it('addresses by who could view it: public, private with nobody named, or unknown', () => {
    const at = (whoCanView: string | null) => postToObject(parseOne({ ...video, whoCanView }).post!, account).object
    expect(at('Everyone').to).toEqual([PUBLIC])
    expect(at('Friends').to).toEqual([])
    expect(at('Friends').cc).toEqual([])
    expect(at('Only me').to).toEqual([])
    // No setting at all reads as `unknown` and fails closed (ADR 0017).
    expect(at(null)).not.toHaveProperty('to')
    expect(at(null)).not.toHaveProperty('cc')
  })

  it('keeps the place name as a Place', () => {
    const o = postToObject(parseOne({ ...video, location: 'Bergen' }).post!, account).object
    expect(o.location).toEqual({ type: 'Place', name: 'Bergen' })
  })
})

describe('buildTiktokActor', () => {
  it('is a Person on the archive domain with nothing to fetch', () => {
    const a = buildTiktokActor(account, '2026-11-26T20:00:00.000Z')
    expect(a.apId).toBe('https://www.tiktok.com/@markusrote')
    expect(a.handle).toBe('@markusrote@tiktok.com')
    expect(a.domain).toBe('tiktok.com')
    expect(a.raw).toMatchObject({ type: 'Person', preferredUsername: 'markusrote', name: 'Markus Rote 🌱' })
    expect(a.raw).not.toHaveProperty('inbox')
    expect(a.raw).not.toHaveProperty('publicKey')
  })

  it('lowercases the username, as TikTok does', () => {
    const { archive } = parseTiktokArchive(file([], { account: { username: 'MarkusRote' } }))
    expect(archive.account).toEqual({ username: 'markusrote', displayName: 'markusrote' })
  })
})
