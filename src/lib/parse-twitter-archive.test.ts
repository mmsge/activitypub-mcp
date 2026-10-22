import { describe, it, expect } from 'vitest'
import { stripHtml } from './strip-html.js'
import {
  buildActor,
  isRetweet,
  mediaUrl,
  normaliseLang,
  parseAccount,
  parseTwitterDate,
  parseYtd,
  profileMediaFile,
  renderTweetHtml,
  tweetToObject,
  type TweetContext,
  type TwitterAccount,
} from './parse-twitter-archive.js'

type AnyObject = Record<string, unknown>

const account: TwitterAccount = {
  accountId: '1856841686',
  username: 'mvrkws',
  displayName: 'Markus',
  createdAt: '2013-09-12T09:22:23.023Z',
  createdVia: 'web',
  bio: 'Første linje\n\nAndre & siste',
  website: '',
  location: 'Bergen, Norway',
  avatarUrl: 'https://pbs.twimg.com/profile_images/861952325279248388/2RQePmv-.jpg',
  headerUrl: 'https://pbs.twimg.com/profile_banners/1856841686/1583408369',
  screenNameChanges: [],
  timeZone: 'Athens',
  verified: false,
}

const ctx = (over: Partial<TweetContext> = {}): TweetContext => ({
  account,
  baseUrl: 'https://bot.example',
  knownAccounts: new Map([
    ['1856841686', 'mvrkws'],
    ['27621869', 'MThorr'],
  ]),
  hasMedia: () => true,
  ...over,
})

/** A tweet shaped like the export's: every number a string, entities by code-point index. */
const tweet = (over: AnyObject = {}): AnyObject => ({
  id_str: '100',
  created_at: 'Wed Sep 18 11:29:17 +0000 2013',
  full_text: 'hei',
  lang: 'no',
  favorite_count: '3',
  retweet_count: '1',
  source: '<a href="http://www.echofon.com/" rel="nofollow">Echofon</a>',
  entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
  ...over,
})

describe('parseYtd', () => {
  it('reads the array behind the assignment, whatever the file is called', () => {
    expect(parseYtd('window.YTD.tweet.part0 = [ {"a": 1} ]')).toEqual([{ a: 1 }])
    expect(parseYtd('window.YTD.tweets.part3 = [ ]')).toEqual([])
  })

  it('refuses something that is not an export instead of returning nothing', () => {
    expect(() => parseYtd('hello')).toThrow(/no array/)
    expect(() => parseYtd('x = {"a": 1}')).toThrow()
  })
})

describe('parseTwitterDate', () => {
  it('reads Twitter\'s v1 format and ISO', () => {
    expect(parseTwitterDate('Wed Sep 18 11:29:17 +0000 2013')).toBe('2013-09-18T11:29:17.000Z')
    expect(parseTwitterDate('2011-05-24T12:05:56.000Z')).toBe('2011-05-24T12:05:56.000Z')
  })
  it('returns null rather than an Invalid Date', () => {
    expect(parseTwitterDate('not a date')).toBeNull()
    expect(parseTwitterDate(undefined)).toBeNull()
    expect(parseTwitterDate('')).toBeNull()
  })
})

describe('parseAccount', () => {
  const files = {
    account: [{ account: { username: 'mvrkws', accountId: '1', accountDisplayName: 'Markus', createdAt: '2013-09-12T09:22:23.023Z', createdVia: 'web', email: 'someone@example.com' } }],
    profile: [{ profile: { description: { bio: 'b', website: 'w', location: 'l' }, avatarMediaUrl: 'a', headerMediaUrl: 'h' } }],
    screenNameChange: [
      { screenNameChange: { accountId: '1', screenNameChange: { changedAt: '2019-03-01T15:08:36.000Z', changedFrom: 'norskus', changedTo: 'mvrkws' } } },
      { screenNameChange: { accountId: '1', screenNameChange: { changedAt: '2013-09-12T14:29:28.000Z', changedFrom: 'Norskus', changedTo: 'norskus' } } },
    ],
  }

  it('takes the final screen name as the identity and lists renames oldest first', () => {
    const a = parseAccount(files)
    expect(a.username).toBe('mvrkws')
    expect(a.screenNameChanges.map((c) => c.changedTo)).toEqual(['norskus', 'mvrkws'])
  })

  it('never carries the email, which is in the export and not part of a profile', () => {
    expect(JSON.stringify(parseAccount(files))).not.toContain('someone@example.com')
  })

  it('fails loudly when the account file has no identity', () => {
    expect(() => parseAccount({ account: [] })).toThrow(/accountId/)
  })
})

describe('normaliseLang', () => {
  it('maps the two retired codes and drops "und"', () => {
    expect(normaliseLang('in')).toBe('id')
    expect(normaliseLang('iw')).toBe('he')
    expect(normaliseLang('und')).toBeNull()
    expect(normaliseLang('no')).toBe('no')
    expect(normaliseLang(undefined)).toBeNull()
  })
})

describe('renderTweetHtml', () => {
  it('escapes, unescapes Twitter\'s own escaping once, and wraps in a paragraph', () => {
    // Twitter exports `&` as `&amp;`; a tweet that literally says "&amp;" arrives as `&amp;amp;`.
    expect(renderTweetHtml('a &amp; b &lt;3 &amp;amp;', {})).toBe('<p>a &amp; b &lt;3 &amp;amp;</p>')
  })

  it('turns a blank line into a paragraph break and a newline into <br>', () => {
    expect(renderTweetHtml('one\ntwo\n\nthree', {})).toBe('<p>one<br>two</p><p>three</p>')
  })

  it('expands t.co links to the real address, keeping the scheme findable in plain text', () => {
    const html = renderTweetHtml('se https://t.co/abc', {
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/a?b=1&c=2', indices: ['3', '19'] }],
    })
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"')
    // content_text is derived with stripHtml; a search for the link must find the whole thing.
    expect(stripHtml(html)).toBe('se https://example.com/a?b=1&c=2')
  })

  it('links hashtags and mentions the way Mastodon renders them', () => {
    const html = renderTweetHtml('@bob #Ordspel', {
      user_mentions: [{ screen_name: 'bob', indices: ['0', '4'] }],
      hashtags: [{ text: 'Ordspel', indices: ['5', '13'] }],
    })
    expect(html).toContain('class="u-url mention"')
    expect(html).toContain('href="https://twitter.com/hashtag/Ordspel"')
    expect(stripHtml(html)).toBe('@bob #Ordspel')
  })

  it('removes the t.co link that stands for an attached picture', () => {
    const html = renderTweetHtml('sjå her https://t.co/pic', {
      media: [{ url: 'https://t.co/pic', indices: ['8', '24'] }],
    })
    expect(html).toBe('<p>sjå her</p>')
  })

  it('leaves empty content for a tweet that was only a picture', () => {
    expect(renderTweetHtml('https://t.co/pic', { media: [{ url: 'https://t.co/pic', indices: ['0', '16'] }] })).toBe('')
  })

  it('counts code points, not UTF-16 units, so an emoji does not shift the link', () => {
    const text = '😀 https://t.co/x'
    const html = renderTweetHtml(text, {
      urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com', indices: ['2', '16'] }],
    })
    expect(html).toContain('href="https://example.com"')
  })

  it('drops an entity that does not match its text instead of linking the wrong word', () => {
    const mismatches: string[] = []
    const html = renderTweetHtml('hello world', {
      hashtags: [{ text: 'nope', indices: ['0', '5'] }],
    }, mismatches)
    expect(html).toBe('<p>hello world</p>')
    expect(mismatches).toHaveLength(1)
  })

  it('drops an out-of-range entity', () => {
    const mismatches: string[] = []
    expect(renderTweetHtml('hi', { hashtags: [{ text: 'x', indices: ['0', '99'] }] }, mismatches)).toBe('<p>hi</p>')
    expect(mismatches[0]).toMatch(/out of range/)
  })

  it('keeps an overlapping entity as plain text rather than emitting its characters twice', () => {
    // A url and a media entity over the same t.co: the first wins, the second is dropped.
    const mismatches: string[] = []
    const html = renderTweetHtml('https://t.co/x', {
      urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com', indices: ['0', '14'] }],
      media: [{ url: 'https://t.co/x', indices: ['0', '14'] }],
    }, mismatches)
    expect(mismatches).toEqual(['overlapping entity dropped'])
    expect(stripHtml(html)).toBe('https://example.com')
  })
})

describe('isRetweet', () => {
  it('is decided by the text, so a hand-typed or orphaned RT counts too', () => {
    expect(isRetweet({ full_text: 'RT @a: x' })).toBe(true)
    expect(isRetweet({ full_text: 'RT @HerbSommerfeld Interesting concept' })).toBe(true)
    expect(isRetweet({ full_text: 'RT is a word' })).toBe(false)
    expect(isRetweet({ full_text: 'hei RT @a' })).toBe(false)
  })
})

describe('tweetToObject', () => {
  it('addresses the tweet by its permalink and attributes it to the account', () => {
    const t = tweetToObject(tweet(), ctx())
    expect(t.apId).toBe('https://twitter.com/mvrkws/status/100')
    expect(t.object.id).toBe(t.apId)
    expect(t.object.url).toBe(t.apId)
    expect(t.object.attributedTo).toBe('https://twitter.com/mvrkws')
    expect(t.object.published).toBe('2013-09-18T11:29:17.000Z')
    expect(t.type).toBe('Note')
  })

  it('is public, because it was: visibility is derived from this addressing', () => {
    expect((tweetToObject(tweet(), ctx()).object.to as string[])).toContain('https://www.w3.org/ns/activitystreams#Public')
  })

  it('keeps the tweet exactly as exported, so nothing mapped is the only copy', () => {
    const original = tweet({ display_text_range: ['0', '3'], some_future_field: { x: 1 } })
    const archived = (tweetToObject(original, ctx()).object.twitterArchive as AnyObject).tweet
    expect(archived).toEqual(original)
  })

  it('carries the counts as standard collections and the client as the generator', () => {
    const o = tweetToObject(tweet(), ctx()).object
    expect((o.likes as AnyObject).totalItems).toBe(3)
    expect((o.shares as AnyObject).totalItems).toBe(1)
    expect(o.generator).toEqual({ type: 'Application', name: 'Echofon', url: 'http://www.echofon.com/' })
  })

  it('records the language, and nothing when Twitter could not tell', () => {
    expect(tweetToObject(tweet({ lang: 'no' }), ctx()).object.contentMap).toEqual({ no: '<p>hei</p>' })
    expect(tweetToObject(tweet({ lang: 'und' }), ctx()).object.contentMap).toBeUndefined()
  })

  it('maps possibly_sensitive to sensitive', () => {
    expect(tweetToObject(tweet({ possibly_sensitive: true }), ctx()).object.sensitive).toBe(true)
    expect(tweetToObject(tweet(), ctx()).object.sensitive).toBe(false)
  })

  it('reads GeoJSON coordinates as [longitude, latitude]', () => {
    const o = tweetToObject(tweet({ coordinates: { type: 'Point', coordinates: ['5.597913', '58.967113'] } }), ctx()).object
    expect(o.location).toEqual({ type: 'Place', latitude: 58.967113, longitude: 5.597913 })
  })

  it('emits hashtags and mentions as the tags the tag= filter and hashtag stats read', () => {
    const o = tweetToObject(tweet({
      full_text: '@bob #Ordspel',
      entities: {
        hashtags: [{ text: 'Ordspel', indices: ['5', '13'] }],
        user_mentions: [{ screen_name: 'bob', id_str: '5', indices: ['0', '4'] }],
        urls: [],
      },
    }), ctx()).object
    expect(o.tag).toEqual([
      { type: 'Hashtag', href: 'https://twitter.com/hashtag/Ordspel', name: '#Ordspel' },
      { type: 'Mention', href: 'https://twitter.com/bob', name: '@bob@twitter.com' },
    ])
    expect(o.cc).toEqual(['https://twitter.com/bob'])
  })

  describe('replies', () => {
    it('points at the parent tweet under the author\'s screen name', () => {
      const o = tweetToObject(tweet({
        in_reply_to_status_id_str: '77',
        in_reply_to_user_id_str: '5',
        in_reply_to_screen_name: 'bob',
      }), ctx()).object
      expect(o.inReplyTo).toBe('https://twitter.com/bob/status/77')
      expect(o.cc).toContain('https://twitter.com/bob')
    })

    it('files a reply to the OTHER imported account under its current name', () => {
      // The reply recorded the name of its day; the tweets live under the current one.
      const o = tweetToObject(tweet({
        in_reply_to_status_id_str: '77',
        in_reply_to_user_id_str: '27621869',
        in_reply_to_screen_name: 'MarkusPedersen',
      }), ctx()).object
      expect(o.inReplyTo).toBe('https://twitter.com/MThorr/status/77')
    })

    it('keeps a self-reply inside the account', () => {
      const o = tweetToObject(tweet({
        in_reply_to_status_id_str: '99',
        in_reply_to_user_id_str: '1856841686',
        in_reply_to_screen_name: 'norskus',
      }), ctx()).object
      expect(o.inReplyTo).toBe('https://twitter.com/mvrkws/status/99')
      expect(o.cc).toEqual([])
    })

    it('still links the parent when no name was recorded', () => {
      const o = tweetToObject(tweet({ in_reply_to_status_id_str: '77' }), ctx()).object
      expect(o.inReplyTo).toBe('https://twitter.com/i/web/status/77')
    })

    it('has no inReplyTo on an ordinary tweet', () => {
      expect('inReplyTo' in tweetToObject(tweet(), ctx()).object).toBe(false)
    })
  })

  describe('retweets', () => {
    const rt = tweet({
      full_text: 'RT @bob: hello',
      entities: { hashtags: [], urls: [], user_mentions: [{ screen_name: 'bob', id_str: '5', indices: ['3', '7'] }] },
    })

    it('are stored as Announce, so object_types: ["Note"] is the account\'s own writing', () => {
      const t = tweetToObject(rt, ctx())
      expect(t.type).toBe('Announce')
      expect(t.object.type).toBe('Announce')
      expect(stripHtml(t.object.content as string)).toBe('RT @bob: hello')
    })

    it('name the original tweet only when the archive says which one it was', () => {
      expect(tweetToObject(rt, ctx()).object.object).toBeUndefined()

      const withPicture = tweet({
        full_text: 'RT @bob: look https://t.co/p',
        entities: {
          hashtags: [], urls: [],
          user_mentions: [{ screen_name: 'bob', id_str: '5', indices: ['3', '7'] }],
          media: [{ url: 'https://t.co/p', indices: ['14', '28'], source_status_id_str: '555', source_user_id_str: '5' }],
        },
        extended_entities: {
          media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Abc.jpg', source_status_id_str: '555', source_user_id_str: '5' }],
        },
      })
      expect(tweetToObject(withPicture, ctx()).object.object).toBe('https://twitter.com/bob/status/555')
    })
  })

  describe('media', () => {
    const photo = (over: AnyObject = {}) => tweet({
      full_text: 'bilete https://t.co/p',
      entities: { hashtags: [], urls: [], user_mentions: [], media: [{ url: 'https://t.co/p', indices: ['7', '21'] }] },
      extended_entities: {
        media: [{
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/Abc123.jpg',
          sizes: { large: { w: '1024', h: '768' } },
          ...over,
        }],
      },
    })

    it('serves an archived photo from here, named after its tweet, with its size', () => {
      const t = tweetToObject(photo(), ctx())
      expect(t.mediaFiles).toEqual(['100-Abc123.jpg'])
      expect(t.object.attachment).toEqual([expect.objectContaining({
        type: 'Document',
        mediaType: 'image/jpeg',
        url: 'https://bot.example/archive/media/twitter/mvrkws/100-Abc123.jpg',
        width: 1024,
        height: 768,
        archived: true,
        sourceUrl: 'https://pbs.twimg.com/media/Abc123.jpg',
      })])
    })

    it('carries the author\'s alt text when there is one, and invents none', () => {
      expect(((tweetToObject(photo({ ext_alt_text: 'ein hund' }), ctx()).object.attachment as AnyObject[])[0]!).name).toBe('ein hund')
      expect(((tweetToObject(photo(), ctx()).object.attachment as AnyObject[])[0]!).name).toBeNull()
    })

    it('falls back to the original CDN address when the archive lacks the file', () => {
      const t = tweetToObject(photo(), ctx({ hasMedia: () => false }))
      expect(t.mediaFiles).toEqual([])
      expect(t.missingMedia).toEqual(['100-Abc123.jpg'])
      expect(((t.object.attachment as AnyObject[])[0]!)).toMatchObject({
        url: 'https://pbs.twimg.com/media/Abc123.jpg',
        archived: false,
      })
    })

    it('keeps the best mp4 of a video, with its length and a poster', () => {
      const t = tweetToObject(tweet({
        extended_entities: {
          media: [{
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/Poster.jpg',
            sizes: { large: { w: '1280', h: '720' } },
            video_info: {
              duration_millis: '7167',
              variants: [
                { bitrate: '832000', content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/640x360/Low.mp4' },
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x/pl/Playlist.m3u8' },
                { bitrate: '2176000', content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/1280x720/High.mp4' },
              ],
            },
          }],
        },
      }), ctx())
      expect(t.mediaFiles).toEqual(['100-High.mp4'])
      expect((t.object.attachment as AnyObject[])[0]).toMatchObject({
        mediaType: 'video/mp4',
        duration: 'PT7.167S',
        icon: { type: 'Image', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/Poster.jpg' },
      })
    })

    it('marks an animated GIF as one', () => {
      const t = tweetToObject(tweet({
        extended_entities: {
          media: [{
            type: 'animated_gif',
            media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/G.jpg',
            video_info: { variants: [{ bitrate: '0', content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/G.mp4' }] },
          }],
        },
      }), ctx())
      expect((t.object.attachment as AnyObject[])[0]).toMatchObject({ mediaType: 'video/mp4', animatedGif: true })
    })
  })

  it('refuses a tweet it cannot date rather than storing an Invalid Date', () => {
    expect(() => tweetToObject(tweet({ created_at: 'whenever' }), ctx())).toThrow(/created_at/)
    expect(() => tweetToObject(tweet({ id_str: undefined }), ctx())).toThrow(/id_str/)
  })
})

describe('buildActor', () => {
  it('builds the handle, the Person document and the profile fields', () => {
    const a = buildActor(account, 'https://bot.example', new Set())
    expect(a.apId).toBe('https://twitter.com/mvrkws')
    expect(a.handle).toBe('@mvrkws@twitter.com')
    expect(a.domain).toBe('twitter.com')
    expect(a.summaryHtml).toBe('<p>Første linje</p><p>Andre &amp; siste</p>')
    expect(a.raw).toMatchObject({
      type: 'Person',
      preferredUsername: 'mvrkws',
      published: '2013-09-12T09:22:23.023Z',
      attachment: [{ type: 'PropertyValue', name: 'Location', value: 'Bergen, Norway' }],
    })
  })

  it('invents no inbox or key', () => {
    const raw = buildActor(account, 'https://bot.example', new Set()).raw
    expect(raw.inbox).toBeUndefined()
    expect(raw.publicKey).toBeUndefined()
  })

  it('serves the avatar and banner from here, finding a banner the export gave an extension', () => {
    const present = new Set(['1856841686-2RQePmv-.jpg', '1856841686-1583408369.jpg'])
    const a = buildActor(account, 'https://bot.example', present)
    expect(a.iconUrl).toBe('https://bot.example/archive/media/twitter/mvrkws/1856841686-2RQePmv-.jpg')
    expect(a.raw.image).toEqual({ type: 'Image', url: 'https://bot.example/archive/media/twitter/mvrkws/1856841686-1583408369.jpg' })
    expect(a.profileFiles).toEqual({ avatar: '1856841686-2RQePmv-.jpg', header: '1856841686-1583408369.jpg' })
  })

  it('falls back to Twitter\'s own addresses when the archive lacks the images', () => {
    const a = buildActor(account, 'https://bot.example', new Set())
    expect(a.iconUrl).toBe(account.avatarUrl)
    expect(a.profileFiles).toEqual({ avatar: null, header: null })
  })

  it('records the renames and the rest of the profile under twitterArchive', () => {
    const a = buildActor({ ...account, screenNameChanges: [{ changedAt: '2019-03-01T15:08:36.000Z', changedFrom: 'norskus', changedTo: 'mvrkws' }] }, 'https://bot.example', new Set())
    expect((a.raw.twitterArchive as AnyObject).screenNameChanges).toHaveLength(1)
    expect((a.raw.twitterArchive as AnyObject).accountId).toBe('1856841686')
  })
})

describe('profileMediaFile / mediaUrl', () => {
  it('matches on the prefix with or without an extension', () => {
    expect(profileMediaFile(account, 'https://x/y/1583408369', new Set(['1856841686-1583408369.png']))).toBe('1856841686-1583408369.png')
    expect(profileMediaFile(account, 'https://x/y/1583408369', new Set())).toBeNull()
    expect(profileMediaFile(account, null, new Set())).toBeNull()
  })

  it('lowercases the account in the URL and tolerates a trailing slash on the base', () => {
    expect(mediaUrl('https://bot.example/', 'MThorr', 'f.jpg')).toBe('https://bot.example/archive/media/twitter/mthorr/f.jpg')
  })
})
