-- Give back the attempts spent on the YouTube consent wall.
--
-- Every probe from the box was answered with a 302 to `consent.youtube.com/m?…&gl=FI`
-- rather than a video: 200 probes, 200 errors, 0 verdicts. The probe now sends the
-- `SOCS=CAI` consent cookie, which was measured on 2026-08-17 to return 200 for a Short and
-- 303 to /watch for a non-Short from that same IP.
--
-- The rows those probes touched carry an attempt each, and at three they would drop out of
-- the work queue for a reason that no longer exists. This hands them back. It repairs data
-- rather than schema, which is why it is a migration and not a script: migrations run at
-- container start, so the fix lands in the same deploy as the cookie that makes it useful.
--
-- Deliberately narrow. It matches only the consent redirect, so a genuine 404 or timeout
-- keeps its attempt and its error, and it leaves `is_short_method` alone — no row that
-- reached a verdict is touched, and the ~10.7k terminal ones are not in scope at all.
UPDATE "youtube_videos"
SET "is_short_attempts" = 0,
    "is_short_error" = NULL
WHERE "is_short_method" IS NULL
  AND "is_short_error" LIKE '%consent.youtube.com%';
