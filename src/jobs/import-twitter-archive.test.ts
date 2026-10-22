import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyMedia,
  loadArchive,
  objectRow,
  planArchives,
  tweetFileNames,
  type LoadedArchive,
} from './import-twitter-archive.js'
import { tweetToObject, type TwitterAccount } from '../lib/parse-twitter-archive.js'

type AnyObject = Record<string, unknown>

const ytd = (name: string, rows: unknown[]) => `window.YTD.${name}.part0 = ${JSON.stringify(rows, null, 1)}`

/** An unzipped export on disk: just enough of one for loadArchive and the planner. */
function writeArchive(root: string, opts: { username: string; accountId: string; tweets: AnyObject[]; media?: string[] }): string {
  const dir = join(root, opts.username)
  const data = join(dir, 'data')
  mkdirSync(join(data, 'tweet_media'), { recursive: true })
  mkdirSync(join(data, 'profile_media'), { recursive: true })
  writeFileSync(join(data, 'account.js'), ytd('account', [{
    account: { username: opts.username, accountId: opts.accountId, accountDisplayName: opts.username, createdAt: '2013-09-12T09:22:23.023Z', email: 'private@example.com' },
  }]))
  writeFileSync(join(data, 'profile.js'), ytd('profile', [{ profile: { description: { bio: 'bio', website: '', location: '' } } }]))
  writeFileSync(join(data, 'tweet.js'), ytd('tweet', opts.tweets.map((tweet) => ({ tweet }))))
  for (const f of opts.media ?? []) writeFileSync(join(data, 'tweet_media', f), 'bytes')
  return dir
}

const tweet = (id: string, over: AnyObject = {}): AnyObject => ({
  id_str: id,
  created_at: 'Wed Sep 18 11:29:17 +0000 2013',
  full_text: `tweet ${id}`,
  lang: 'no',
  favorite_count: '0',
  retweet_count: '0',
  entities: { hashtags: [], user_mentions: [], urls: [] },
  ...over,
})

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'twitter-import-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('tweetFileNames', () => {
  it('finds tweet.js, and the numbered parts in numeric order', () => {
    expect(tweetFileNames(['account.js', 'tweets-part10.js', 'tweets-part2.js', 'tweets.js', 'like.js', 'tweet.js'])).toEqual([
      'tweet.js', 'tweets-part2.js', 'tweets-part10.js', 'tweets.js',
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  })
  it('ignores everything else in data/', () => {
    expect(tweetFileNames(['like.js', 'tweet_media', 'tweetdeck.js'])).toEqual([])
  })
})

describe('loadArchive', () => {
  it('reads the account, the tweets and the media directories', () => {
    const dir = writeArchive(root, { username: 'alpha', accountId: '1', tweets: [tweet('10'), tweet('11')], media: ['10-a.jpg'] })
    const a = loadArchive(dir)
    expect(a.account.username).toBe('alpha')
    expect(a.tweets.map((t) => t.id_str)).toEqual(['10', '11'])
    expect([...a.tweetMedia]).toEqual(['10-a.jpg'])
  })

  it('keeps one row per tweet id when parts repeat one', () => {
    const dir = writeArchive(root, { username: 'dupes', accountId: '2', tweets: [tweet('10'), tweet('10')] })
    expect(loadArchive(dir).tweets).toHaveLength(1)
  })

  it('says what is wrong when the folder is not an archive', () => {
    expect(() => loadArchive(root)).toThrow(/not a Twitter archive/)
  })

  it('does not carry the account email anywhere', () => {
    const dir = writeArchive(root, { username: 'mailless', accountId: '3', tweets: [tweet('1')] })
    expect(JSON.stringify(loadArchive(dir).account)).not.toContain('private@example.com')
  })
})

describe('planArchives', () => {
  const archive = (username: string, accountId: string, tweets: AnyObject[], tweetMedia: string[] = []): LoadedArchive => ({
    dir: `/x/${username}`,
    account: {
      accountId, username, displayName: username, createdAt: null, createdVia: null, bio: '', website: '', location: '',
      avatarUrl: null, headerUrl: null, screenNameChanges: [], timeZone: null, verified: null,
    } satisfies TwitterAccount,
    tweets,
    tweetMedia: new Set(tweetMedia),
    profileMedia: new Set(),
  })

  it('counts what it found and names the span of dates', () => {
    const [plan] = planArchives([archive('a', '1', [
      tweet('1', { created_at: 'Mon Jan 01 10:00:00 +0000 2018' }),
      tweet('2', { full_text: 'RT @x: hi', created_at: 'Tue Jan 02 10:00:00 +0000 2018' }),
      tweet('3', { in_reply_to_status_id_str: '1', in_reply_to_user_id_str: '1', created_at: 'Wed Jan 03 10:00:00 +0000 2018' }),
    ])], 'https://bot.example')
    expect(plan!.stats).toMatchObject({ tweets: 3, notes: 2, retweets: 1, replies: 1 })
    expect(plan!.stats.first).toBe('2018-01-01T10:00:00.000Z')
    expect(plan!.stats.last).toBe('2018-01-03T10:00:00.000Z')
  })

  it('reports a tweet it cannot map and imports the rest', () => {
    const [plan] = planArchives([archive('a', '1', [tweet('1'), tweet('2', { created_at: 'garbage' })])], 'https://bot.example')
    expect(plan!.tweets).toHaveLength(1)
    expect(plan!.problems).toEqual([{ tweetId: '2', reason: expect.stringContaining('created_at') }])
  })

  it('lets one account\'s reply to the other land on a tweet that is imported', () => {
    const plans = planArchives([
      archive('mvrkws', '2', [tweet('20', { in_reply_to_status_id_str: '10', in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'OldName' })]),
      archive('MThorr', '1', [tweet('10')]),
    ], 'https://bot.example')
    const reply = plans[0]!.tweets[0]!
    const parent = plans[1]!.tweets[0]!
    expect(reply.object.inReplyTo).toBe(parent.apId)
  })

  it('refuses two archives of the same account, in any case', () => {
    expect(() => planArchives([archive('Same', '1', []), archive('same', '1', [])], 'https://bot.example')).toThrow(/same account/)
  })

  it('lists each media file once, however many tweets share a name', () => {
    const withPhoto = tweet('5', {
      extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P.jpg' }] },
    })
    const [plan] = planArchives([archive('a', '1', [withPhoto], ['5-P.jpg'])], 'https://bot.example')
    expect(plan!.mediaFiles).toEqual(['5-P.jpg'])
    expect(plan!.stats).toMatchObject({ withMedia: 1, mediaFiles: 1, mediaMissing: 0 })
  })
})

describe('objectRow', () => {
  const account = { accountId: '1', username: 'a', displayName: 'a', createdAt: null, createdVia: null, bio: '', website: '', location: '', avatarUrl: null, headerUrl: null, screenNameChanges: [], timeZone: null, verified: null } as TwitterAccount
  const build = (t: AnyObject) => tweetToObject(t, { account, baseUrl: 'https://bot.example', knownAccounts: new Map(), hasMedia: () => true })

  it('derives the columns the way ingestObject does, so every reading tool sees the same row', () => {
    const row = objectRow('https://twitter.com/a', build(tweet('7', {
      full_text: 'se #ord',
      entities: { hashtags: [{ text: 'ord', indices: ['3', '7'] }], user_mentions: [], urls: [] },
    })))
    expect(row).toMatchObject({
      apId: 'https://twitter.com/a/status/7',
      type: 'Note',
      actorApId: 'https://twitter.com/a',
      contentText: 'se #ord',
      url: 'https://twitter.com/a/status/7',
      inReplyTo: null,
      sensitive: false,
      language: 'no',
    })
    expect(row.publishedAt).toEqual(new Date('2013-09-18T11:29:17.000Z'))
    expect(row.tags).toEqual([{ type: 'Hashtag', href: 'https://twitter.com/hashtag/ord', name: '#ord' }])
    expect(row.attachments).toEqual([])
  })

  it('stores the whole object in raw', () => {
    const built = build(tweet('7'))
    expect(objectRow('https://twitter.com/a', built).raw).toBe(built.object)
  })
})

describe('copyMedia', () => {
  it('copies what exists, skips what is already there at the same size, and names what is missing', () => {
    const from = join(root, 'from')
    const to = join(root, 'to', 'twitter', 'a')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, '1-a.jpg'), 'aaaa')
    writeFileSync(join(from, '2-b.jpg'), 'bbbb')

    expect(copyMedia(from, to, ['1-a.jpg', '2-b.jpg', '3-gone.jpg'])).toEqual({ copied: 2, alreadyThere: 0, missing: ['3-gone.jpg'] })
    expect(readFileSync(join(to, '1-a.jpg'), 'utf8')).toBe('aaaa')

    // A second run copies nothing.
    expect(copyMedia(from, to, ['1-a.jpg', '2-b.jpg'])).toEqual({ copied: 0, alreadyThere: 2, missing: [] })

    // A file that changed size is replaced.
    writeFileSync(join(from, '1-a.jpg'), 'aaaaaa')
    expect(copyMedia(from, to, ['1-a.jpg'])).toMatchObject({ copied: 1 })
    expect(readFileSync(join(to, '1-a.jpg'), 'utf8')).toBe('aaaaaa')
  })
})
