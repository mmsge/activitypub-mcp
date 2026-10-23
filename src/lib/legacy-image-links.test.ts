import { describe, it, expect } from 'vitest'
import { candidatesFor, extensionFor, findLegacyLinks, imageUrlFromPage, legacyLinksInTweet, livePageFor, twitpicNumber } from './legacy-image-links.js'

describe('findLegacyLinks', () => {
  it('finds a twitpic link in 2009 tweet text, without the trailing punctuation', () => {
    const links = findLegacyLinks("Watching Seinfeld. It's on http://www.vg.no http://twitpic.com/517yh.")
    expect(links).toEqual([{ host: 'twitpic', id: '517yh', url: 'https://twitpic.com/517yh' }])
  })

  it('finds every host, in order of appearance', () => {
    const links = findLegacyLinks(
      'a yfrog.com/abc123 b http://twitgoo.com/xyz c http://lockerz.com/s/12345 d http://instagr.am/p/Ab_C-d/ e twitpic.com/zz',
    )
    expect(links.map((l) => l.host)).toEqual(['yfrog', 'twitgoo', 'plixi', 'instagram', 'twitpic'])
  })

  it('spells tweetphoto, plixi and lockerz the same, so one photo is one link', () => {
    const links = findLegacyLinks('http://tweetphoto.com/999 http://plixi.com/p/999 http://lockerz.com/s/999')
    expect(links).toEqual([{ host: 'plixi', id: '999', url: 'https://plixi.com/p/999' }])
  })

  it('treats case-different twitpic ids as one photo', () => {
    expect(findLegacyLinks('twitpic.com/ABC twitpic.com/abc')).toHaveLength(1)
  })

  it('ignores twitpic storage and profile paths that are not a photo link', () => {
    expect(findLegacyLinks('http://twitpic.com/show/full/abc http://twitpic.com/photos/someone')).toEqual([])
  })

  it('drops a link Twitter cut short in a truncated retweet', () => {
    expect(findLegacyLinks('RT @SYFY: … by 5pm PT on 7/9 - http://twitpic.com/2 ...')).toEqual([])
    expect(findLegacyLinks('RT @x: look http://twitpic.com/3zy…')).toEqual([])
    expect(findLegacyLinks('RT @x: look http://yfrog.com/abc...')).toEqual([])
  })

  it('keeps a link followed by "..." in a tweet that is not a retweet', () => {
    expect(findLegacyLinks('Guess where I am http://twitpic.com/517yh ...')).toHaveLength(1)
  })

  it('keeps a whole link at the end of a sentence', () => {
    expect(findLegacyLinks('Look at this http://twitpic.com/517yh. Nice.')).toHaveLength(1)
  })

  it('drops a twitpic id too short to be real', () => {
    expect(findLegacyLinks('http://twitpic.com/1 http://twitpic.com/abc')).toEqual([])
  })

  it('ignores ordinary links', () => {
    expect(findLegacyLinks('http://www.vg.no https://youtu.be/VS2Cnx_eL6s')).toEqual([])
  })
})

describe('legacyLinksInTweet', () => {
  it('reads a twitpic link that is only in the expanded t.co url', () => {
    const tweet = {
      full_text: 'Nice view https://t.co/abc',
      entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'http://twitpic.com/d7ceew' }] },
    }
    expect(legacyLinksInTweet(tweet).map((l) => l.id)).toEqual(['d7ceew'])
  })

  it('counts a link once when it is in both the text and the entities', () => {
    const tweet = {
      full_text: 'see http://twitpic.com/517yh',
      entities: { urls: [{ url: 'http://twitpic.com/517yh', expanded_url: 'http://twitpic.com/517yh' }] },
    }
    expect(legacyLinksInTweet(tweet)).toHaveLength(1)
  })
})

describe('twitpicNumber', () => {
  it('decodes a short id as base 36', () => {
    expect(twitpicNumber('10')).toBe('36')
    expect(twitpicNumber('517yh')).toBe(String(5 * 36 ** 4 + 1 * 36 ** 3 + 7 * 36 ** 2 + 34 * 36 + 17))
  })

  it('matches the number in the live twitpic image link', () => {
    // twitpic.com/426yk serves dn3pm25xmtlyu.cloudfront.net/photos/large/6820796.jpg
    expect(twitpicNumber('426yk')).toBe('6820796')
  })

  it('is null for an id that is not base 36', () => {
    expect(twitpicNumber('ab_c')).toBeNull()
  })
})

describe('candidatesFor', () => {
  it('tries twitpic image URLs before the page', () => {
    const c = candidatesFor({ host: 'twitpic', id: '517yh', url: 'https://twitpic.com/517yh' })
    expect(c[0]).toEqual({ url: 'twitpic.com/show/full/517yh', match: 'exact', kind: 'image' })
    expect(c.at(-1)).toEqual({ url: 'twitpic.com/517yh', match: 'exact', kind: 'page' })
    expect(c.some((x) => x.match === 'prefix' && x.url.includes(twitpicNumber('517yh')!))).toBe(true)
  })

  it('has at least one candidate for every host', () => {
    for (const host of ['twitpic', 'yfrog', 'twitgoo', 'plixi', 'instagram'] as const) {
      expect(candidatesFor({ host, id: '123', url: '' }).length).toBeGreaterThan(0)
    }
  })
})

describe('imageUrlFromPage', () => {
  it('reads og:image in either attribute order', () => {
    expect(imageUrlFromPage('<meta property="og:image" content="http://x.com/a.jpg">', 'twitpic.com/1')).toBe('http://x.com/a.jpg')
    expect(imageUrlFromPage('<meta content="http://x.com/b.jpg" property="og:image" />', 'twitpic.com/1')).toBe('http://x.com/b.jpg')
  })

  it('reads the twitpic photo element and resolves a relative src against the page', () => {
    expect(imageUrlFromPage('<img id="photo-display" src="/show/large/517yh.jpg">', 'twitpic.com/517yh')).toBe(
      'http://twitpic.com/show/large/517yh.jpg',
    )
  })

  it('unescapes &amp; in the url', () => {
    expect(imageUrlFromPage('<link rel="image_src" href="http://a.com/i?x=1&amp;y=2">', 'http://a.com/')).toBe('http://a.com/i?x=1&y=2')
  })

  it('takes the first image only when asked to, for a page that is just the photo', () => {
    const html = '<html><img src="https://dn3pm25xmtlyu.cloudfront.net/photos/large/6820796.jpg?Expires=1&amp;Signature=s"></html>'
    expect(imageUrlFromPage(html, 'https://twitpic.com/426yk')).toBeNull()
    expect(imageUrlFromPage(html, 'https://twitpic.com/426yk', { anyImg: true })).toBe(
      'https://dn3pm25xmtlyu.cloudfront.net/photos/large/6820796.jpg?Expires=1&Signature=s',
    )
  })

  it('is null for a page naming no image', () => {
    expect(imageUrlFromPage('<html><body>gone</body></html>', 'twitpic.com/1')).toBeNull()
  })
})

describe('livePageFor', () => {
  it('has a live page only for twitpic', () => {
    expect(livePageFor({ host: 'twitpic', id: '426yk', url: '' })).toBe('https://twitpic.com/426yk')
    expect(livePageFor({ host: 'yfrog', id: 'abc', url: '' })).toBeNull()
  })
})

describe('extensionFor', () => {
  it('maps image types and falls back to bin', () => {
    expect(extensionFor('image/jpeg; charset=binary')).toBe('jpg')
    expect(extensionFor('image/png')).toBe('png')
    expect(extensionFor('text/html')).toBe('bin')
    expect(extensionFor(null)).toBe('bin')
  })
})
