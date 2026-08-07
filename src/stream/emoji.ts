import { firstHttpUrl } from '../lib/ap-object.js'
import { escapeHtml } from '../lib/html.js'
import { isAllowedImageHost } from './image-proxy.js'

/**
 * Custom emoji — the `:vy:` shortcodes a fediverse post writes inline, and the
 * picture each one stands for.
 *
 * They federate exactly the way hashtags do: as entries in the object's `tag`
 * array, `{ type: "Emoji", name: ":vy:", icon: { url: "https://…png" } }`. The
 * ingest has always kept that array verbatim in `objects.tags` (see
 * `extractTags`), so nothing here fetches anything from a remote server — the
 * icons were in the database the whole time. `toHashtags` simply dropped every
 * entry that was not a Hashtag, which is why the stream rendered "Vy :vy: har
 * nye vassflaskar" with the shortcode showing.
 *
 * The post's text keeps the literal shortcode; substituting it is the renderer's
 * job. Doing that substitution is also the one place a federated post gets to
 * put an `<img>` on a public page, so two rules hold throughout:
 *
 *   1. Only a shortcode the post itself declared is ever replaced. The map is
 *      built per post from its own `tag` array — a post cannot borrow another
 *      post's emoji, and an undeclared `:shrug:` stays as text.
 *   2. The `<img>` is built here, from a URL that has been parsed and checked.
 *      Nothing from the payload is interpolated into markup unescaped.
 */

export interface Emoji {
  /** The bare shortcode, colons stripped: `vy`. */
  shortcode: string
  /** The icon on its origin CDN. Proxied at render time — see `imageSrc`. */
  url: string
}

/**
 * Mastodon's own shortcode alphabet.
 *
 * Also what makes the substitution below safe to do with a regex over escaped
 * text: a name of only word characters cannot contain `&`, `<` or `"`, so a
 * shortcode survives HTML-escaping unchanged and the matcher cannot be steered
 * into a tag or an attribute by a cleverly named emoji.
 */
const SHORTCODE = /^[a-zA-Z0-9_]+$/
const SHORTCODE_IN_TEXT = /:([a-zA-Z0-9_]+):/g

/**
 * The renderable custom emoji of a raw AP `tag` array.
 *
 * "Renderable" is doing real work: an emoji whose icon sits on a host we do not
 * serve images from is dropped here rather than carried to a view that cannot
 * draw it. That case is a boost of someone else's post, whose emoji live on
 * their instance's CDN — not on the list in `image-proxy.ts`, and not in the
 * `img-src` the meg.msge.no Caddy block sends. Left in, it would render as a
 * broken-image icon in the middle of a sentence; dropped, the shortcode stays as
 * text, which is what the page shows today and is perfectly readable.
 *
 * That is the opposite of the call `Media` makes for attachments, deliberately:
 * a photo from an unanticipated host has no fallback worth the name, so it is
 * hotlinked and the CSP decides. An emoji has one, so it is used.
 */
export function toEmojis(raw: unknown): Emoji[] {
  if (!Array.isArray(raw)) return []
  const out: Emoji[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const tag = t as Record<string, unknown>
    if (String(tag.type).toLowerCase() !== 'emoji') continue
    if (typeof tag.name !== 'string') continue
    const shortcode = tag.name.replace(/^:+|:+$/g, '')
    if (!SHORTCODE.test(shortcode) || seen.has(shortcode)) continue
    const url = firstHttpUrl(tag.icon)
    if (!url) continue
    let host: string
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:') continue
      host = u.hostname
    } catch {
      continue
    }
    if (!isAllowedImageHost(host)) continue
    seen.add(shortcode)
    out.push({ shortcode, url })
  }
  return out
}

/**
 * Draw a post's custom emoji into its already-sanitised HTML.
 *
 * `srcFor` is where the image is actually loaded from — `imageSrc` on the site,
 * so emoji go through the signed proxy like every other picture (ADR 0021), and
 * the identity function in the Atom feed, where a path relative to meg.msge.no
 * would resolve against the reader's feed app and load nothing.
 *
 * Preconditions, both met by `sanitizeHtml`: the input is balanced, and every
 * `<` that is *not* a tag has already been escaped to `&lt;`. So a `<` found
 * here always opens a real tag, and skipping from it to the next `>` always
 * skips exactly one tag — which is what keeps a shortcode inside an `href` from
 * being replaced and breaking the link.
 *
 * Text inside `<code>` and `<pre>` is left alone. There `:vy:` is far more
 * likely to be a shortcode someone is writing *about* than one they meant to
 * draw, and a code block that silently swaps a token for a picture is a code
 * block that lies about its contents.
 */
export function renderEmojis(
  html: string,
  emojis: Emoji[],
  srcFor: (url: string) => string | undefined,
): string {
  if (!html || emojis.length === 0) return html
  const byShortcode = new Map(emojis.map((e) => [e.shortcode, e.url]))

  const substitute = (text: string): string =>
    text.replace(SHORTCODE_IN_TEXT, (whole, shortcode: string) => {
      const url = byShortcode.get(shortcode)
      if (!url) return whole
      const src = srcFor(url)
      if (!src) return whole
      // The shortcode is the alt text, not "" and not a guessed description: it is
      // the only name anyone has for this picture, it is what the author typed, and
      // it is what a reader copying the sentence should get back.
      return `<img class="emoji" src="${escapeHtml(src)}" alt="${whole}" title="${whole}"`
        + ' loading="lazy" decoding="async" referrerpolicy="no-referrer">'
    })

  let out = ''
  let i = 0
  // Nesting depth inside <code>/<pre>, so a <code> within a <pre> does not end the
  // literal region early when it closes.
  let literal = 0

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    const text = html.slice(i, lt === -1 ? html.length : lt)
    out += literal > 0 ? text : substitute(text)
    if (lt === -1) break

    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // Unreachable for sanitiser output; emitting the remainder verbatim rather
      // than substituting into it is the safe way to be wrong about that.
      out += html.slice(lt)
      break
    }
    const tag = html.slice(lt, gt + 1)
    out += tag
    const m = /^<(\/?)(code|pre)\b/i.exec(tag)
    if (m) literal = m[1] ? Math.max(0, literal - 1) : literal + 1
    i = gt + 1
  }

  return out
}
