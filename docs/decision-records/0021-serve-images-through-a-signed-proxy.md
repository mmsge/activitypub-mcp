# 0021 — Serve the stream's images through a signed proxy, and never resize them

- **Status:** Accepted
- **Date:** 2026-08-04
- **Contributors:** Markus (asked & decided: build the proxy, cap the cache small and cautious at 250 MB, and tighten the CSP in a second step after the proxy is verified live) + Claude (proposed the signed-URL/allowlist/LRU shape, argued against resizing, implemented)
- **Affects:** `src/stream/image-proxy.ts`, `src/stream/image-cache.ts`, `src/stream/router.tsx`, `src/stream/views/`, `docker-compose.yml`, `src/config.ts`
- **Topics:** stream, images, privacy, caching, security, csp

## Context

ADR 0018 shipped meg.msge.no with images hotlinked from their origin CDNs, and
flagged the proxy as a committed phase two. Two things made it worth doing.

**The page's own privacy claim did not hold.** The colophon says the page fetches no
fonts and no scripts from anyone — true — while reading it made requests to seven
CDNs: `cdn.masto.host`, `pixelfed.babb.no`, `loops.video`, `*.loopsusercontent.com`,
`bookwyrm.social`, `*.digitaloceanspaces.com`, `minreol.dk`, Last.fm's Fastly. Each
of those learns the reader's IP and that they are reading Markus' page. The CSP had
to name all of them, which is barely a policy at all next to `img-src 'self' data:`.

**The archive rots.** It goes back to 2016 and origin CDNs rotate. A Pixelfed or
Loops URL that 404s takes the image with it, and the archive is then quietly wrong
about what was posted.

## Decision

**Images are fetched by this app and served from this origin**, at
`/bilete/<sig>/<base64url of the upstream URL>`.

**It is not a resizer.** No decode, no re-encode, no thumbnails. The box is a CAX11
with two vCPUs shared by ~37 containers, and image processing on it is a way to make
every other service unresponsive. Bytes in, same bytes out. If the pages need
smaller images later, the answer is `width`/`height` attributes and `loading="lazy"`
— both already there — not a resize pipeline.

Three things keep it from being an open proxy, which is the failure mode that
actually matters: an open image proxy is someone else's bandwidth bill and someone
else's abuse report, arriving at Markus' domain.

1. **Signed URLs.** The path carries an HMAC of the exact upstream URL, keyed by a
   subkey derived from `SESSION_SECRET` (`hmac(secret, "meg:image-proxy:v1")`) —
   derived rather than used directly so an admin session cookie and a public image
   URL are never signed by the same key. A URL this app did not mint does not
   resolve.
2. **A host allowlist**, applied when minting *and* again when serving, and again
   after every redirect. The signature says "we minted this"; the allowlist says
   "and it is still a host we are willing to fetch from" even if the key leaked. The
   wildcard match is anchored on a dot: `endsWith('digitaloceanspaces.com')` also
   accepts `evildigitaloceanspaces.com`, which anyone can register.
3. **A bounded LRU disk cache**, so a crawl cannot fill the disk — on this box a
   full disk is an outage for every service on it.

Redirects are followed **by hand**. `redirect: 'follow'` would chase a 302 from an
allowed host to any host at all, and the allowlist would stop meaning anything. Each
hop must stay on the allowlist and stay https: an image silently downgraded to http
is a request we made in the clear on a reader's behalf. That decision is a pure
function, `redirectTarget`, because it is the part that must be exhaustively tested.

**No SVG.** Served from our own origin, an SVG runs script in our origin. The
allowlist is JPEG, PNG, GIF, WebP, AVIF, checked on fetch *and* re-checked when
reading from disk so a cache written under an older, looser list is not still served.

**The cache is 250 MB by default** (`STREAM_IMAGE_CACHE_MB`), Markus' call:
"small and cautious". It lives in a named Docker volume so a rebuild does not throw
it away and refetch everything from seven CDNs at once. Eviction is by last access,
swept down to 80% of the budget rather than to the line, so a sweep is not needed on
every subsequent write. `STREAM_IMAGE_CACHE_MB=0` disables the whole thing and the
page goes back to hotlinking — **and says so**: the colophon renders whichever is
actually true rather than always asserting the flattering one.

**The CSP is tightened separately.** `img-src` in the meg.msge.no Caddy block
(naustet-server) still names the seven CDNs. It is narrowed to `'self' data:` in a
follow-up PR once the proxy is confirmed working against the live archive. Markus'
call, and the right one: a proxy bug and a locked-down CSP landing together means
every image on the page breaks at the same moment, with nothing to bisect.

## Consequences

- Reading meg.msge.no now contacts one host. The colophon's claim is true.
- Bandwidth moves from the origin CDNs onto this box — for a page nobody has yet
  found, against a 250 MB cache, which is the point of capping it.
- A dead origin degrades to a missing image, not a broken page: the route answers
  404 and everything around the `<img>` still renders. An image that 404s upstream
  *before* it is ever cached is lost — the proxy preserves what it has seen, it is
  not a backfill. Warming the cache for the deep archive is a separate job if it
  ever matters.
- `sweep()` is single-flight, which means awaiting it while one is already running
  joins the *running* one — "a sweep has happened", not "the cache is under budget
  as of now". Fine for housekeeping, and documented at the function, because it cost
  a flaky test to discover.
- Everything security-relevant is verified by execution, not by inspection: an
  end-to-end fetch of a real 43 KB BookWyrm cover, a 304 on revalidation, and 404s
  for a forged signature, a swapped URL, an unlisted host and garbage. Plus 38 unit
  tests over the allowlist, the signature, the redirect rules and eviction.
