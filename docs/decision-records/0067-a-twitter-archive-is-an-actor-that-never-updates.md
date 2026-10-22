# 0067 — A Twitter archive is an actor that never updates

**Status:** Accepted
**Date:** 2026-10-22
**Topics:** twitter, import, archive, actors, media, privacy
**Contributors:** Markus (supplied the two exports — `@MThorr`, 2009–2020, and `@mvrkws`/`@norskus`, 2013–2020 — and the requirements: every post available like any other actor's, stored as `@<username>@twitter.com`, as much of the archive as possible kept) + Claude (mapped the export onto the ActivityPub model, found that the actor lookup would have dialled twitter.com, and designed the media serving)

**Affects:** `src/lib/parse-twitter-archive.ts`, `src/lib/archive-actors.ts`,
`src/jobs/import-twitter-archive.ts`, `scripts/import-twitter-archive.ts`,
`src/activitypub/archive-media.ts`, `src/lib/fetch-actor.ts`, `src/jobs/refresh-actors.ts`,
`src/config.ts`, `docker-compose.yml`

## Context

Two Twitter accounts, both Markus', were exported in November 2020: 27,978 tweets for
`@MThorr` and 9,346 for `@mvrkws` (earlier `@norskus`), with 603 photos and videos. The
accounts can no longer be regenerated into the same export, so the zip is the only
complete copy. The request was to make every post available through this server the way
other accounts' posts are, filed as `@<username>@twitter.com`.

"The way other accounts' posts are" is a precise constraint here. Every reading tool takes
an `actor_handle` and queries `objects` by `actor_ap_id`; hashtag stats, search, media and
the REST API all sit on that one table. A separate `tweets` table, as LinkedIn and YouTube
got, would have meant re-implementing each of them.

## Decision

**An archive is an actor and a set of `objects` rows, nothing more.**

1. **The actor** is `https://twitter.com/<username>` with handle `@<username>@twitter.com`,
   `software = 'twitter'`. The username is the *final* screen name: the export's own tweets
   were written under earlier ones (`norskus`, `MarkusPedersen`), but an account is one
   identity and its tweets live under the name it ended on. Renames are kept in
   `raw.twitterArchive.screenNameChanges`. `public_key_pem` and `inbox_url` are empty
   strings — the columns are NOT NULL, and a made-up inbox is a promise nobody can keep.
2. **A tweet is a Note whose `ap_id` is its permalink**, `https://twitter.com/<username>/status/<id>`.
   It is stored through the same helpers `ingestObject` uses (`extractContent`,
   `stripHtml`, `extractTags`, …), so the row is indistinguishable in shape from one
   received over the wire — but *not* through `ingestObject` itself, whose enrichment
   queues and msge.no webhook would fire 37,000 times for nothing.
3. **The tweet is kept whole.** `raw.twitterArchive.tweet` is the export's tweet object
   verbatim. Everything mapped — text as Mastodon-shaped HTML with expanded links, hashtag
   and mention tags, `inReplyTo`, language, `location`, `generator` (the client), `likes` /
   `shares` totals, `sensitive`, attachments — is a view of it. That is what makes the
   importer an upsert: a parser fix is a re-run, not a re-export.
4. **Retweets are `Announce`.** A 2020 export of a retweet carries only truncated
   "RT @user: …" text; it names no original tweet. An AP boost points at its object, so
   there is nothing honest to point at. They are stored as what the archive can prove — the
   retweet, in this account's timeline — with type `Announce`, so `object_types: ["Note"]`
   is the account's own writing and the default keeps everything. When the retweet had a
   picture, the picture entity does name the original, and `object` points at it. Detection
   is by text (`RT @x`), because hand-typed 2009 retweets and ones whose author has since
   vanished have no mention entity (about 20 of 3,800).
5. **Replies stay linked.** A reply to either imported account points at that account's
   current name, so the thread resolves inside the database (251 `inReplyTo` links do);
   a reply to anyone else points at the screen name recorded that day, or at
   `twitter.com/i/web/status/<id>` when none was.
6. **`twitter.com` is an archive domain** (`src/lib/archive-actors.ts`). `resolveActorByHandle`
   answers it from the table (case-insensitively, since Twitter handles are) instead of
   WebFinger-ing Twitter; `fetchActor` never refreshes it; `refreshStaleActors` skips it.
   Without this the feature works on the day of the import and then logs 20 failed refreshes
   per run for ever, and `get_actor_posts` returns "could not resolve actor" the whole time.
7. **Photos and videos are served from here.** The attachments' original
   `pbs.twimg.com`/`video.twimg.com` addresses are not something to depend on. Files are
   copied to `ARCHIVE_MEDIA_DIR/twitter/<account>/` (a named volume that nothing sweeps —
   unlike the image cache) and served read-only at `/archive/media/twitter/<account>/<file>`
   with Range support so video seeks. Names are matched against a whitelist before touching
   the filesystem. A file the archive lacks (two, in `@MThorr`'s) keeps the original CDN URL
   and `archived: false`.
8. **What is not read.** `account.js` carries an email address and the export holds a phone
   number, an IP audit, direct messages, likes, and follower/following lists. The task was
   posts. None is imported, none appears in the actor's `raw`, and DMs in particular are other
   people's words.

Visibility is `public`: the accounts were public (`protected-history.js` is empty in both),
so the posts carry `to: [Public]`. That makes them readable on the REST API like any public
post. The public stream is unaffected — it is an allowlist (`STREAM_SOURCES`), and
`@…@twitter.com` is not on it.

## Consequences

- `get_actor_posts`, `search_actor_content`, `get_hashtag_stats`, `get_actor_media` and the
  REST equivalents work on `@MThorr@twitter.com` and `@mvrkws@twitter.com` unchanged.
- The two accounts together add 37,324 rows to `objects` and about 265 MB to a volume. At the
  time of writing the box had 5.7 GB free.
- `get_engagement` on a tweet would try to fetch `twitter.com` live; the counts as of
  November 2020 are in `raw.likes.totalItems` / `raw.shares.totalItems` instead.
- Re-importing is safe and idempotent. A post hidden with `deleted_at` stays hidden.
- A third archive (Instagram, a blog) needs a parser and one entry in `ARCHIVE_DOMAINS`; the
  actor, media route and refresh exclusion are already general.

## Alternatives rejected

- **A `tweets` table.** Would have been simpler to import and would have left every reading
  tool unable to see it.
- **Storing retweets as Notes.** Mixes 4,600 retweets into "what I wrote" with no way to
  separate them short of parsing the text again.
- **Hotlinking `pbs.twimg.com`.** Dead links are not "kept".
- **Importing through `ingestObject`.** Correct but wasteful at this size, and the
  side-effects are all things an archive must not trigger.
