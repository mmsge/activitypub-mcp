import { describe, it, expect } from 'vitest'
import { toEmojis, renderEmojis } from './emoji.js'

/** The `tag` entry skvip.lol actually federates for `:vy:`. */
const vy = {
  id: 'https://skvip.lol/emojis/24644',
  type: 'Emoji',
  name: ':vy:',
  updated: '2025-07-25T17:25:33Z',
  icon: {
    type: 'Image',
    mediaType: 'image/png',
    url: 'https://cdn.masto.host/skviplol/custom_emojis/images/000/024/644/original/ce311c0add485bb6.png',
  },
}
const VY_URL = vy.icon.url

const hashtag = { type: 'Hashtag', href: 'https://skvip.lol/tags/togtut', name: '#togtut' }

/** Stand-in for imageSrc — the proxy path, not the origin URL. */
const proxied = (url: string) => `/bilete/sig/${Buffer.from(url).toString('base64url')}`

describe('toEmojis', () => {
  it('reads the Emoji entries of a real Mastodon tag array', () => {
    expect(toEmojis([hashtag, vy])).toEqual([{ shortcode: 'vy', url: VY_URL }])
  })

  it('ignores everything that is not an Emoji', () => {
    const mention = { type: 'Mention', href: 'https://skvip.lol/users/markus', name: '@markus' }
    expect(toEmojis([hashtag, mention])).toEqual([])
    expect(toEmojis(null)).toEqual([])
    expect(toEmojis({ type: 'Emoji' })).toEqual([]) // not an array
  })

  it('accepts a bare icon URL and a list, not only the nested object', () => {
    expect(toEmojis([{ ...vy, icon: VY_URL }])[0]?.url).toBe(VY_URL)
    expect(toEmojis([{ ...vy, icon: [vy.icon] }])[0]?.url).toBe(VY_URL)
  })

  it('tolerates a name sent without its colons', () => {
    expect(toEmojis([{ ...vy, name: 'vy' }])[0]?.shortcode).toBe('vy')
  })

  /**
   * The boost case. Another instance's emoji CDN is not a host this origin serves
   * images from, and it is not in the meg.msge.no `img-src` either — so the emoji
   * is dropped here and the shortcode survives as readable text, rather than
   * reaching the page as a broken image.
   */
  it('drops an emoji whose icon is on a host we do not serve images from', () => {
    expect(toEmojis([{ ...vy, icon: { url: 'https://emoji.example.invalid/vy.png' } }])).toEqual([])
  })

  it('drops an emoji with no usable icon, and one served over http', () => {
    expect(toEmojis([{ ...vy, icon: undefined }])).toEqual([])
    expect(toEmojis([{ ...vy, icon: { url: 'http://cdn.masto.host/vy.png' } }])).toEqual([])
  })

  /**
   * A shortcode is matched with a regex over the post's own text, so a name that is
   * not a plain word is refused rather than escaped: nothing in the wild needs it,
   * and the alternative is a matcher whose behaviour depends on what a remote
   * server chose to call its picture.
   */
  it('refuses a shortcode outside Mastodon\'s own alphabet', () => {
    for (const name of [':a b:', ':a-b:', ':a.b:', '::', ':a"b:', ':<img>:']) {
      expect(toEmojis([{ ...vy, name }])).toEqual([])
    }
  })

  it('keeps the first of a repeated shortcode', () => {
    const other = { ...vy, icon: { url: 'https://skvip.lol/other.png' } }
    expect(toEmojis([vy, other])).toEqual([{ shortcode: 'vy', url: VY_URL }])
  })
})

describe('renderEmojis', () => {
  const emojis = toEmojis([vy])

  it('draws a declared shortcode, through the src resolver it is given', () => {
    const html = renderEmojis('<p>Vy :vy: har nye vassflaskar!</p>', emojis, proxied)
    expect(html).toContain(`src="${proxied(VY_URL)}"`)
    expect(html).toContain('class="emoji"')
    // The shortcode is the alt text — the only name anyone has for the picture.
    expect(html).toContain('alt=":vy:"')
    expect(html).not.toContain(':vy: har')
    expect(html).toContain('Vy ')
    expect(html).toContain(' har nye vassflaskar!')
  })

  it('leaves the origin URL alone when the resolver is the identity — the feed case', () => {
    expect(renderEmojis('<p>:vy:</p>', emojis, (u) => u)).toContain(`src="${VY_URL}"`)
  })

  it('leaves a shortcode the post did not declare as text', () => {
    expect(renderEmojis('<p>:vy: :sj:</p>', emojis, proxied)).toContain(':sj:')
  })

  it('is a no-op with no emoji, and on empty HTML', () => {
    expect(renderEmojis('<p>:vy:</p>', [], proxied)).toBe('<p>:vy:</p>')
    expect(renderEmojis('', emojis, proxied)).toBe('')
  })

  it('does nothing when the resolver declines the URL', () => {
    expect(renderEmojis('<p>:vy:</p>', emojis, () => undefined)).toBe('<p>:vy:</p>')
  })

  /**
   * The rule that keeps this from breaking links. A shortcode inside an attribute
   * is not text, and substituting there would put an `<img>` inside an `href`.
   */
  it('never substitutes inside a tag', () => {
    const html = renderEmojis('<a href="https://x.test/:vy:/a">:vy:</a>', emojis, proxied)
    expect(html).toContain('href="https://x.test/:vy:/a"')
    expect(html.match(/<img/g)?.length).toBe(1)
  })

  it('leaves code and pre alone, including a code block inside a pre', () => {
    expect(renderEmojis('<p><code>:vy:</code></p>', emojis, proxied)).toBe('<p><code>:vy:</code></p>')
    expect(renderEmojis('<pre><code>:vy:</code>:vy:</pre>', emojis, proxied))
      .toBe('<pre><code>:vy:</code>:vy:</pre>')
    // …and picks substitution back up after the block closes.
    expect(renderEmojis('<p><code>:vy:</code> :vy:</p>', emojis, proxied)).toContain('<img')
  })

  it('draws adjacent and repeated shortcodes', () => {
    expect(renderEmojis('<p>:vy::vy:</p>', emojis, proxied).match(/<img/g)?.length).toBe(2)
  })

  it('leaves escaped text escaped', () => {
    const html = renderEmojis('<p>Vy &amp; NSB :vy: 1 &lt; 2</p>', emojis, proxied)
    expect(html).toContain('Vy &amp; NSB ')
    expect(html).toContain(' 1 &lt; 2')
  })

  /**
   * The URL travels into an attribute, so it is escaped on the way. It cannot carry
   * a quote today — `toEmojis` parsed it with `new URL` and checked its host — but
   * the escaping is what makes that a defence in depth rather than the only defence.
   */
  it('escapes the src it is handed', () => {
    const html = renderEmojis('<p>:vy:</p>', emojis, () => 'https://x.test/a"onerror="alert(1)')
    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).toContain('&quot;onerror=&quot;')
  })
})
