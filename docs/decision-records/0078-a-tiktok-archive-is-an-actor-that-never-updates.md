# 0078 — A TikTok archive is an actor that never updates

**Status:** Accepted
**Date:** 2026-11-26
**Topics:** tiktok, import, archive, actors, engagement, privacy
**Contributors:** Markus (supplied the archive and the plan: one archive actor after ADR 0067,
every post in the export including photo posts and posts no longer on the profile, an admin
upload with a preview plus a command-line import, metadata and links only, and the check that
the export's `Date` equals yt-dlp's `timestamp` to the second) + Claude (implemented it, chose
the build file's checks, the sort keyset and the `get_engagement` refusal)

**Affects:** `src/lib/parse-tiktok-archive.ts`, `src/lib/build-tiktok-archive.ts`,
`src/lib/archive-actors.ts`, `src/jobs/import-tiktok-archive.ts`, `src/jobs/archive-objects.ts`,
`src/jobs/import-twitter-archive.ts`, `scripts/build-tiktok-archive.ts`,
`scripts/import-tiktok-archive.ts`, `src/admin/import-kinds.ts`, `src/admin/router.tsx`,
`src/admin/views/import.tsx`, `src/mcp/tools/actor-posts.ts`, `src/lib/fetch-engagement.ts`,
`docs/openapi.yaml`

## Context

Markus' TikTok account, @markusrote, holds 1 900 posts from 9 November 2020 to 26 November
2026. The request was to ask about them the way other posts are asked about ("the most viewed
video of 2025", "videos about NRK from 2023", "most comments", "how many with #nynorsk") and
get a link to the video on TikTok back. The video files were explicitly out of scope.

Two sources live on the Mac in `~/Jottacloud/TikTok/`, not on the server:

- **TikTok's data export**, `user_data_tiktok.json`. `Post.Posts.VideoList` lists all 1 900
  posts with `Date` (UTC), `Likes`, `Sound`, `Location`, `WhoCanView` and a `Link` that is a
  signed CDN address valid for ten days. It has no video id, no caption, no views and no
  comment count. The same file holds direct messages, searches and watch history.
- **yt-dlp's metadata**, `meta/<id>.info.json`, 1 840 files with the id, `timestamp`, caption,
  views, likes, comments, reposts, duration and page. yt-dlp only sees what is on the profile
  today, and not photo posts.

ADR 0067 already answered "an account's posts, readable by every tool" for Twitter: an archive
actor and `objects` rows. Every reading tool takes an `actor_handle` and reads `objects`.

## Decision

**The same shape as Twitter: `@markusrote@tiktok.com` and one `objects` row per post.**

1. **The file is built on the Mac.** `npm run build-tiktok-archive -- ~/Jottacloud/TikTok`
   joins the two sources and writes one `tiktok-archive.json` in our own format,
   `tiktok-archive/1`. Only that file is uploaded. The export never leaves the Mac, and the
   build reads `Post.Posts.VideoList` and named fields only: DMs, searches and history are
   never read, and the CDN links are never copied. The script checks its output with the
   importer's own parser before writing, so a file it writes is one the importer takes whole.
2. **The join is the exact second.** The export has no id, so the only shared key is time.
   `Date` read as UTC equals yt-dlp's `timestamp` to the second: 1 836 of the 1 840 info
   files match with zero offset. There is no tolerance window. A window would pair two posts
   made a minute apart with each other's numbers, and nothing downstream could tell. A second
   shared by two posts, or by two info files, pairs none of them and is reported. Info files
   matching no export post are reported and left out, because the export is the scope.
3. **A post with an id is a `Video` at its own page.** `ap_id` and `url` are
   `https://www.tiktok.com/@markusrote/video/<id>` (`/photo/` for a photo post yt-dlp found).
   The caption becomes Mastodon-shaped HTML with hashtags and mentions linked, so `tag`,
   `content_text` and search work unchanged. Likes, shares and comments are AS2 `likes`,
   `shares` and `replies` collections with `totalItems`. Views and the sound have no AS2
   property and stay in `raw.tiktokArchive.post`, which carries the whole post, as 0067 does.
   Duets and stitches are ordinary videos: they name a video that is not in the database, so
   there is no `inReplyTo`.
4. **A post without metadata keeps what the export knows.** 64 posts have no info file: 62
   photo posts from 2022 (several image links in `Link`) and 2 videos from 2023 that are no
   longer on the profile. They become an `Image` or a `Video` with the date, likes and sound
   only. They have no page, so their `ap_id` is synthetic and stable,
   `https://www.tiktok.com/@markusrote#arkiv-<UTC second>`, and **their `url` is null**. A
   tool must never hand out a link that does not open. Nothing in `objects` constrains
   `ap_id`'s shape, so a fragment is accepted (checked on Postgres 16).
5. **Who could view it is the addressing.** "Everyone" is `to: [Public]`. Any other setting
   is `to: []`, which the `visibility` column reads as private. No setting at all leaves the
   post unaddressed, which reads as `unknown` and fails closed (ADR 0017).
6. **`tiktok.com` and `www.tiktok.com` are archive domains.** The handle is on the first and
   every page, the actor's `ap_id` included, on the second, so both must be known for
   `resolveActorByHandle`, `fetchActor` and `refreshStaleActors` to stay off the network.
   `get_engagement` now refuses any archive host and points at the stored counts, instead of
   dialling twitter.com or tiktok.com (0067 had left that one open).
7. **Not through `ingestObject`, and no files.** The rows are derived by the same helpers,
   now shared in `src/jobs/archive-objects.ts` with the Twitter importer. No enrichment
   queue, no msge.no webhook, no `ARCHIVE_MEDIA_DIR/tiktok`. The import is an upsert on
   `ap_id`, so a newer export or a parser fix is a re-run; `deleted_at` is never touched.
8. **Admin → Import → TikTok-arkiv, under Fediverse.** Every effect is in this database, so
   it previews like the other file imports (ADR 0073). `npm run import-tiktok-archive` is the
   same import from a shell. Fediverse is where the archive actors' posts are read; a separate
   "social media" category would hold one import.
9. **`get_actor_posts` sorts by a count.** `sort_by` takes `published` (the default, as
   before), `views`, `likes`, `shares` or `replies`, read from the stored object by one SQL
   expression per count with a `jsonb_typeof` guard. Posts without the count come last in
   either direction. Paging is a keyset on (count, `published_at`, id); a count cursor carries
   its sort and is refused under another, and the date cursor is unchanged. Every post gets
   `engagement` {views, likes, shares, replies}. It works for the Twitter archives too.

The public stream is unaffected: it is an allowlist (`STREAM_SOURCES`) whose platforms are
ActivityPub software, and `@…@tiktok.com` is not on it, exactly as for Twitter.

## Consequences

- The four questions are one call each: `get_actor_posts` with `since`/`until`,
  `sort_by: "views"` and `limit: 1`; `tag: "nrk"` with a year, or `search_actor_content`
  for "NRK" in the caption; `sort_by: "replies"`; `get_hashtag_stats` on the actor.
- Counts are as of the build, not live. `raw.tiktokArchive.post` and the actor's
  `raw.tiktokArchive.generatedAt` say when. A newer count is a new build and a re-import.
- `engagement` on a federated post shows what was stored when it arrived, often null. The
  tool description says to use `get_engagement` for live Mastodon counts.
- 1 900 rows is small; the upload limit is 25 MB and the file is around 1 MB.
- A video taken off the profile after an import is a known gap. A newer build has no
  metadata for it, so it arrives under the synthetic `ap_id` as a second row with no `url`,
  and the first row keeps its id, counts and a `url` that no longer opens. Nothing deletes
  the first row; hide it with `deleted_at` if it matters. Folding the two would need the
  importer to match on `published_at` against stored rows, which this import does not do.

## Alternatives rejected

- **A `tiktok_posts` table.** Would have left every reading tool blind to it, as 0067 found.
- **Uploading TikTok's export and joining on the server.** Puts DMs and search history on
  the server for the length of a request, and the yt-dlp metadata is a folder of 1 840 files.
- **Joining within a time window.** Silently pairs neighbours; the zero-offset match rate
  shows there is nothing to recover.
- **A url for every post.** A profile link or a search link for the 64 would be a link that
  does not open the post. Null says what is true.
- **Storing the CDN links.** They expire in ten days.
