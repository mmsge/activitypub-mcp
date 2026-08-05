# 0022 — Render remote video as a poster, and load the origin's player only on request

**Status:** Accepted
**Date:** 2026-08-05
**Topics:** stream, video, privacy, csp, embeds, images, federation
**Contributors:** Markus (asked & decided: use Rullen's embeds; change all three repos rather than patch the consumer alone) + Claude (proposed the click-to-load facade over an always-visible iframe, found the two other faults, implemented)

## Context

Every Rullen post on `meg.msge.no` rendered as a row of broken-image icons.

Three faults compounded, and only the first was the one anybody would guess.

**The view drew videos with `<img>`.** The video branch of `Media` carried a comment
saying "Poster and a link out" while the code passed `a.url` — the attachment itself
— as the `<img src>`:

```tsx
const isVideo = a.mediaType?.startsWith('video/')
if (isVideo) {
  // Poster and a link out, never an inline player...
  return <a class="poster" href={a.url}><img src={imageSrc(a.url)} … /></a>
}
```

Nothing anywhere read a poster field, so the comment described an intent the code
had never had. A browser handed an `.mp4` or a `.webm` in an `<img>` draws the
broken-image icon and has nothing to fall back on.

**Rullen had a poster and never sent it.** Every clip carries a JPEG in
`clips.thumbnail_s3_key`, used as `<video poster=…>` on Rullen's own pages and
exposed by its `stories/latest` JSON. It appeared in no ActivityPub payload. Nor
could the consumer work it out: the key is `thumbnails/{userId}/{randomUUID}.jpg` —
a fresh UUID with no relation to the video's own key.

**Each clip rendered twice.** Rullen federates one story two ways at once: a root
`Note` carrying every clip as an attachment (32 of them, for the London story), and
one `Note` per clip replying to that root. `hydratePosts` folds a thread into its
root, so the card drew the root's attachments and then every clip again, each in a
thread block with no text in it — the staggered second row of placeholders.

## Decision

### A video renders its poster, or says what it is — never a broken `<img>`

`Attachment` gains `posterUrl` and `durationSeconds`. `posterUrl` is read from the
attachment's `icon`, falling back to `preview` and `image`, and through the same
signed proxy as every other image on the page (0021). With no poster, the view
renders a text chip — `▶ Sjå video · 0:16` — that still links out.

The rule is that a missing poster must degrade to *words*, never to an `<img>` whose
`src` is not an image. That is the whole bug, and it is easy to reintroduce by
"reusing" the attachment URL.

### The origin's player, behind a click

Rullen serves a framable player at `/embed/stories/{user}/{slug}` — the one route
family on which it sets `frame-ancestors *` and drops `X-Frame-Options`; the story
page itself is `frame-ancestors 'none'` and would be blocked. It advertises the URL
on the story Note as a `preview` Link with `mediaType: text/html`, and the stream
reads it into `PostEntry.embedUrl`. The stream reads the field rather than deriving
the URL, so Rullen's URL shape is not hardcoded here.

The player sits inside a closed `<details>`, on a `loading="lazy"` `<iframe>`, with
the poster and `«32 snuttar · 7 min»` in the `<summary>`. Nothing is fetched from
the origin until the reader opens it. No JavaScript — the page has none, and one
embed is not a reason to start.

**The alternative was an always-visible iframe, and it was rejected.** 0021 exists
because the page claimed to fetch nothing from anyone while quietly contacting seven
CDNs; the fix was to make the claim true. An embed that loaded on sight would undo
that immediately — Rullen's JS, its Google Fonts and its video, on every page view,
for every reader including the ones who never press play. Behind a click it is the
reader's choice, and the summary says what the choice costs. The colophon now says
it too:

> Opnar du ein videospelar i eit innlegg, hentar nettlesaren din han frå tenesta han
> ligg på — men ikkje før du trykkjer.

**The load-bearing claim is that a lazy iframe inside a closed `<details>` does not
load.** It holds in Chromium — verified with the network log: zero requests to
`rullen.no` before the click, one after. If a browser is ever found to fetch it
eagerly, the fallback is a server-side facade (the poster links to `?spel=<refId>`
and the router renders the iframe for that one card) — still no JavaScript,
guaranteed rather than relied upon, at the cost of a page reload.

`frame-src https://rullen.no` had to be added to the `meg.msge.no` CSP over in
naustet-server. The policy is `default-src 'none'`, so without it the iframe is
blocked outright.

### Thread parts that only repeat the root are dropped

When folding a thread into its root, any attachment the root already shows is
removed from the part, and the part is dropped if that leaves it with nothing to
say. A part with its own text keeps the text and loses the duplicate media — a
caption is something Markus wrote.

Keyed on the attachment URL rather than written as a Rullen rule. The
root-plus-one-reply-per-attachment shape is not Rullen's alone, and a platform check
is a thing someone has to remember to edit for the next server that does it.

### Two fixes found on the way

- **Thread media ignored the content warning.** The root's media was gated on
  `sensitive`; the thread's was not. A warned post collapsed its body and showed its
  thread's media underneath regardless.
- **A poster that fails to load must not take the play control with it.** The label
  is positioned over the poster, so a broken image collapsed the `<summary>` to zero
  height — no way to reach the video at all. It now has a `min-height`. A dead image
  costs the picture, not the control.

## Consequences

- Posters only exist for posts Rullen has re-federated. `handleUpdate` is an upsert
  (0011), so the backfill over there refreshes them in place.
- `rullen.no` joins `IMAGE_HOSTS` and the Caddy `img-src`. Both remain load-bearing
  until the CSP is tightened to `'self'`.
- Rullen's clips are 720×1280, so posters are capped at 24rem with `object-fit:
  cover`. Uncapped, one entry filled a screen.
- The stream reads `icon`, `preview` and `image` for a poster and ISO-8601
  `duration` for a length. Any peer that sends either now gets a better card for
  free; none but Rullen sends them today.
