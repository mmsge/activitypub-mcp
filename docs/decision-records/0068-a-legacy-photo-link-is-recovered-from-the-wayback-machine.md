# 0068 — A legacy photo link is recovered from the Wayback Machine

**Status:** Accepted
**Date:** 2026-10-23
**Topics:** twitter, archive, media, wayback, twitpic
**Contributors:** Markus (asked for the pictures behind his pre-2011 photo links, chose the archive exports as the source, a local folder as the destination, and both accounts across every legacy host) + Claude (worked out where the files might still be and wrote the recovery)

**Affects:** `src/lib/legacy-image-links.ts`, `src/lib/wayback.ts`,
`src/lib/load-twitter-archive.ts`, `src/jobs/import-twitter-archive.ts`,
`scripts/recover-legacy-images.ts`, `package.json`

## Context

Before Twitter hosted photos itself (2011), a photo tweet was text plus a link to a
separate host: Twitpic, yfrog, Twitgoo, TweetPhoto (later Plixi, later Lockerz), and
early Instagram. `@MThorr` alone has hundreds of them between 2009 and 2014. ADR 0067
imports the archive's own media, but for these tweets the archive holds only the link.

Twitpic is the exception: it stopped taking uploads in 2014 but still serves every photo
page, with the image on CloudFront behind a signed, expiring link. The others are gone,
and for them the Wayback Machine is the one place the files might be.

## Decision

**A script reads the archive exports and fetches each photo from twitpic.com where it
still lives, and otherwise from the Wayback Machine.** It
writes to a local folder, one file per tweet, with an `index.csv` and a resumable
`state.json`. It does not write to the database or the archive media store; whether to
attach the recovered pictures to their posts is a later decision, made once it is clear
how many come back.

1. **Links are found in both the text and the expanded URLs.** A 2009 tweet has the
   twitpic link in its text; a 2012 one has a t.co link there and the twitpic link only
   in `entities.urls[].expanded_url`.
2. **Retweets are skipped.** Their photos are other people's, the same reasoning by which
   Kvitra drops retweets. `--include-retweets` brings them back; files an earlier run
   saved for retweets are moved to `_retweets/`, never deleted. Long retweets were also
   truncated to fit 140 characters, sometimes mid-link (`http://twitpic.com/2 ...`), and
   such a fragment is dropped in any case, along with any Twitpic id under four characters.
3. **One photo is one lookup.** Links are normalised (TweetPhoto, Plixi and Lockerz ids
   are the same photo; Twitpic ids are case-insensitive), so a photo linked from two
   tweets is fetched once and copied to both.
4. **The live Twitpic page comes first.** Its image link is signed and expires, so the
   page is read fresh each time and the image fetched straight after; the index records
   the page, not the expiring link. Any failure there falls through to Wayback.
5. **In Wayback, image URLs are tried before the page.** Each host has a list of candidate URLs, best
   first: the direct image endpoints (`twitpic.com/show/full/<id>`, `yfrog.com/<id>:medium`
   and so on), Twitpic's storage paths by photo number (the short id is the number in base
   36), and last the photo page, whose `og:image` or photo element names the file.
6. **The bytes decide, not the label.** A capture is saved only when its first bytes are a
   JPEG, PNG, GIF, WebP or BMP. Wayback sometimes serves an error page under an image
   capture, and saving that as `.jpg` would hide a miss.
7. **archive.org and Twitpic are treated as somebody else's machines.** One request at a time, 1.5 s
   apart by default, with `Retry-After` honoured and exponential back-off on 429 and 5xx.
   A missing photo is recorded and not asked about again unless `--retry-missing`.

## Consequences

- No database or app config is needed, so the script runs on a laptop next to the
  unzipped exports. That needed `loadArchive` moved out of the import job, which imports
  the database client, into `src/lib/load-twitter-archive.ts`. The job re-exports it.
- Some photos will not come back. `index.csv` says which, so the gaps are visible rather
  than silent.
- Twitpic's storage path is `dn3pm25xmtlyu.cloudfront.net/photos/<size>/<number>.jpg`,
  where the number is the short id in base 36 (checked on `426yk` → `6820796`). Wayback
  tries it as a prefix because the extension is not known.
- If twitpic.com goes dark one day, the live step finds nothing and every Twitpic photo
  falls back to Wayback with no change needed.
- Instagram is looked up in Wayback only, not live, because Instagram's media endpoints
  now require a login.
