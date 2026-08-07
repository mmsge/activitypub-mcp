# 0032 — Draw the custom emoji that were already in the database, and drop the ones we cannot serve

**Status:** Accepted
**Date:** 2026-08-07
**Topics:** stream, activitypub, rendering, images, security

**Contributors:** Markus (reported the symptom from a screenshot of /reise/torucon-2026, asked whether the emoji could be got from the remote server, and said to implement it) + Claude (agent decision — no human input on the technical choices below)

## Context

A post on meg.msge.no read:

> Vy :vy: har nye vassflaskar! For ei vending av året.

`:vy:` is a custom emoji. The obvious reading of that symptom is that the picture
lives on the remote server and we never fetched it — so the fix would be a
crawler, a cache, and a refresh policy for emoji that instances redefine.

That reading is wrong, and it is worth writing down why, because the same wrong
reading is available to anyone who sees the next shortcode leak through.

Custom emoji federate. They arrive in the object's `tag` array, alongside the
hashtags, in the same delivery as the post:

```json
{ "id": "https://skvip.lol/emojis/24644", "type": "Emoji", "name": ":vy:",
  "icon": { "type": "Image", "mediaType": "image/png",
            "url": "https://cdn.masto.host/skviplol/custom_emojis/images/…png" } }
```

`extractTags` (ADR 0001) has always stored that array verbatim in `objects.tags`,
on create, on edit, on boost, and in the re-derivation backfill. Every emoji of
every post we hold has been in the database the whole time, icon URL and all.

The stream simply never looked. `toHashtags` reads the same column and skips
every entry whose `type` is not `Hashtag` — its docstring said so plainly:
"Mentions and emoji are ignored." Nothing needed fetching. Something needed
rendering.

## Decision

**Read the emoji out of the tag array we already store, and draw them at render
time.** No network access, no new table, no cache, no backfill — `toEmojis` is a
sibling of `toHashtags` over the same column.

Three choices inside that are not obvious.

### The entry carries origin URLs; the renderer decides where the image loads from

`PostEntry.emojis` is `{ shortcode, url }` with the origin CDN's URL, and the
substitution happens per surface. The site draws them through the signed image
proxy (ADR 0021), like every other picture on the page. The Atom feed draws them
with the origin URL, because a subscriber's reader resolves a relative
`/bilete/…` against its own page and loads nothing.

Folding the `<img>` into `entry.html` back in the query layer would have been
fewer moving parts, and would have silently shipped proxy paths into the feed.

### An emoji we cannot serve becomes text again, not a broken image

`toEmojis` drops any emoji whose icon is on a host outside `IMAGE_HOSTS`. That
is the boost case: another instance's post carries its own instance's emoji CDN,
which is neither a host the proxy will fetch from nor one named in the
meg.msge.no `img-src`. Rendered anyway, it is a broken-image icon in the middle
of a sentence; dropped, the shortcode stays as text, which is exactly what the
page showed before this change and is perfectly readable.

This is the opposite of the call `Media` makes for attachments, which hotlinks an
unanticipated host and lets the CSP decide. The difference is that a photo has no
fallback worth the name and an emoji has a good one.

The consequence to remember: **adding an emoji CDN to `IMAGE_HOSTS` is what makes
a boosted post's emoji appear**, and that list must stay in step with the
`img-src` in the meg.msge.no Caddy block over in naustet-server.

### The substitution is the one place a federated post can add markup, so it is fenced

This is the first time text from another server produces an element that was not
in the payload. Four rules keep that narrow:

1. Only a shortcode the post itself declared is replaced. The map is built per
   post from its own `tag` array, so a post cannot borrow another's emoji and an
   undeclared `:shrug:` stays as text.
2. Shortcodes must match `[a-zA-Z0-9_]+` — Mastodon's own alphabet. That is also
   what makes a regex over HTML-escaped text safe: such a name cannot contain
   `&`, `<` or `"`, so it survives escaping unchanged and a remote server cannot
   name a picture in a way that steers the matcher into a tag.
3. The `<img>` is built here from a URL that has been through `new URL` and a
   host check, and escaped into the attribute regardless.
4. `renderEmojis` skips from `<` to the next `>` without substituting, so a
   shortcode inside an `href` cannot be turned into an image and break the link.
   It relies on `sanitizeHtml` having run first — that is what guarantees a `<`
   found in the input opens a real tag.

Text inside `<code>` and `<pre>` is left alone: there `:vy:` is far likelier to be
a shortcode someone is writing *about*, and a code block that swaps a token for a
picture lies about its contents.

## Consequences

- Posts render as their authors wrote them. No migration, no backfill, no refetch
  — every emoji this unlocks was already stored.
- Content warnings get their emoji too. The warning is plain text out of
  `objects.summary`, so the view escapes it before drawing into it; book cards
  pass no emoji and keep the plain interpolation they had.
- Thread parts read their own `tag` array rather than the root's, so a shortcode
  first used halfway down a thread is not lost.
- Feed *titles* keep the literal shortcode. They are derived by stripping tags,
  and an emoji stripped out of a one-word post would leave the entry untitled.
- An emoji whose icon 404s on the origin renders as a broken image rather than
  falling back to text — we check the host, not the bytes. Acceptable: the same
  is true of every other image in the archive.
- `firstUrl` moved from query.ts to `lib/ap-object.ts` as `firstHttpUrl`, shared
  by the video-poster and emoji-icon readers.
