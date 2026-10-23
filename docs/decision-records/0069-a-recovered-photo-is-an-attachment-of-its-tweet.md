# 0069 — A recovered photo is an attachment of its tweet

**Status:** Accepted
**Date:** 2026-10-23
**Topics:** twitter, import, archive, media, twitpic
**Contributors:** Markus (wanted the photos ADR 0068 recovered shown on their tweets; chose to have the import attach them, the photo link removed from the text, and rsync to the box as the transfer) + Claude (designed the matching and wrote it)

**Affects:** `src/lib/legacy-image-links.ts`, `src/lib/parse-twitter-archive.ts`,
`src/lib/load-twitter-archive.ts`, `src/jobs/import-twitter-archive.ts`,
`scripts/import-twitter-archive.ts`, `README.md`

## Context

ADR 0068 recovered 886 photos behind the pre-2011 photo links in Markus' own tweets, into
a local folder. The tweets in the archive still show only the link, now dead apart from
Twitpic's. The archive already serves the export's own photos from the `archive_media`
volume as attachments (ADR 0067).

`import-twitter-archive` is idempotent and rewrites each tweet's row from the export. An
attachment added to the rows by anything else would be wiped by the next re-import.

## Decision

**The import attaches recovered photos itself.** `--legacy-images=<dir>` points it at the
recovery folder; without the flag it maps exactly as before.

1. **Matched by tweet id and link.** The recovery script's file names carry the tweet id,
   host and photo id. A file is attached to a tweet only when that tweet's text holds the
   link for that photo, so a file cannot land on the wrong post. `_retweets/` is not read.
2. **Stored like the export's own media.** The file is copied into
   `twitter/<account>/` on the media volume as `<tweet id>-<host>-<photo id>.<ext>`,
   served by the existing route, with the same copy rules (same size is left alone, files
   before rows).
3. **The link leaves the text, as a native photo link does.** The photo is the
   attachment now. The space before it and a Twitpic-style " - " after it go too. The
   original link is kept on the attachment as `sourceUrl`, and the tweet as exported stays
   whole in `raw.twitterArchive.tweet`.
4. **Nothing is invented.** No alt text and no size, because neither survived. A
   `recoveredFrom` field names the host, so a recovered photo can be told apart from one
   Twitter kept.
5. **Unclaimed files are reported.** A recovered file no tweet claims is listed rather
   than dropped quietly.

## Consequences

- A re-import keeps the photos, as long as it is given the same `--legacy-images` folder.
  Run without it, the rows go back to text-only and the files stay on the volume unused.
  The README says to always pass it.
- The same photo linked from two tweets is stored once per tweet, as the recovery folder
  holds it.
- Search over `content_text` no longer finds a tweet by its twitpic URL once its photo is
  attached. The URL is still in `raw` and on the attachment.
