-- "Date unknown" for NeoDB marks: a backlog title Markus has seen but cannot date is
-- dated 2000-01-01 on minreol, because the picker insists on a date and the mark's comment
-- is never parsed. The parser decodes that sentinel to `watched_at = NULL` plus this flag,
-- so the FLAG carries "unknown" and no date maths ever sees the year 2000. See decision
-- record 0060.
--
-- The one-off decode of rows already stored rides the migration rather than a script,
-- because migrations run at container start (the 0037 precedent). The window is ±1 day
-- around the sentinel, on the instant: minreol's own picker sends a local-midnight shape
-- like 1999-12-31T22:00:00+00:53, which a single-day check in any one zone would miss.
-- These two bounds are the same strings as SENTINEL_WINDOW in src/lib/neodb-mark.ts, and a
-- test reads this file to keep them in step. Verified against the live archive on
-- 2026-09-25: nothing sits in the window (the oldest shelf date is 2014), so this UPDATE
-- touching 0 rows on deploy is the expected result, not a silent failure.
ALTER TABLE "neodb_marks" ADD COLUMN "watched_date_unknown" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "neodb_marks"
SET "watched_at" = NULL, "watched_date_unknown" = true, "updated_at" = now()
WHERE "watched_at" >= '1999-12-31T00:00:00.000Z'::timestamptz
  AND "watched_at" < '2000-01-03T00:00:00.000Z'::timestamptz;
