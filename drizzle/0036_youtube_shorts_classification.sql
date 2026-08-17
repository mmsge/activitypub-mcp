-- One row per distinct VIDEO behind the watch history: the enrichment table
-- `0034_youtube_watches` reserved `youtube_watches_video_idx` for.
--
-- ~92k rows behind ~96k watches. Per video, not per watch: 3,530 videos were watched more
-- than once, so a per-watch flag would be both redundant and able to contradict itself.
--
-- It exists to answer one question the archive cannot: is this a Short? Nothing in the data
-- says. Every watch row carries a `/watch?v=` URL and never a `/shorts/` one, because My
-- Activity does not distinguish them, and the Data API exposes no Shorts flag and no aspect
-- ratio either. See ADR 0049 for the full derivation; the short version is that a flat
-- "under three minutes" test mislabels about 10% of what it catches, because Shorts did not
-- exist before roughly September 2020 and the ceiling was 60 seconds until 15 October 2024.
CREATE TABLE "youtube_videos" (
	-- The 11-character video id. Matches youtube_watches.video_id, which is indexed for
	-- exactly this join.
	"video_id" text PRIMARY KEY NOT NULL,

	-- TRI-STATE, not a bare boolean: true, false, or unknown. Nullable rather than an enum
	-- because get_youtube_watches already serves `is_short` as boolean | null, and a third
	-- representation of the same three states would be one too many.
	--
	-- A null here is ambiguous on its own — `is_short_method` is what disambiguates it:
	--
	--   is_short       | is_short_method  | meaning
	--   ---------------+------------------+--------------------------------------------
	--   false          | duration_rule    | certain, decided offline from duration+date
	--   false          | api_metadata     | certain, decided against the real upload date
	--   true/false     | probe            | verified by requesting the /shorts/ URL
	--   NULL           | unclassifiable   | TERMINAL — no duration, no working URL
	--   NULL           | NULL             | pending — still ambiguous, awaiting a stage
	"is_short" boolean,

	-- HOW it was decided. This is the point of the exercise, not decoration: it lets a later
	-- run upgrade a guess to a verified answer, and lets the stats say "of the ones we
	-- actually know" without pretending.
	--
	-- 'unclassifiable' is TERMINAL and covers the ~10.7k videos with no duration — the
	-- deleted and private ones, the same population youtube_watches.unresolved marks. They
	-- must NEVER be retried: reopening them would spend the daily quota re-asking about 11%
	-- of the archive forever. Every work-queue predicate below is written so that is free
	-- rather than a condition someone could forget.
	"is_short_method" text,

	-- When ANY stage last looked at this row, verdict or not. NULL means never examined,
	-- which is how stage 0 finds its work — so a video arriving in a future watch-history
	-- import is picked up by the same job with no special casing, and a second run over a
	-- settled archive reads an empty index instead of re-deciding 92k rows.
	"is_short_checked_at" timestamp with time zone,

	-- For backoff and for giving up. An exhausted counter is deliberately NOT the same state
	-- as 'unclassifiable': the row keeps a null method and is simply not selected, so
	-- re-arming it is a matter of resetting this counter rather than reasoning about which
	-- nulls are real. Mirrors catalog_metadata.fetch_attempts.
	"is_short_attempts" integer DEFAULT 0 NOT NULL,
	"is_short_error" text,

	-- ── videos.list(part=snippet,contentDetails) ─────────────────────────────────────
	-- Persisted rather than thrown away. Classification needs only the first two, but the
	-- call returns the rest for free and the year-in-review work will want them.

	-- The real UPLOAD date, and the whole reason a network stage is worth anything. The
	-- archive knows when a video was WATCHED, which bounds the upload date from above and
	-- never from below — a 45-second video watched in 2025 could have been uploaded in 2013.
	-- Only this column makes the era rules exact rather than approximate.
	"published_at" timestamp with time zone,
	-- The video's best known length. Stage 0 seeds it from max() over the video's own watch
	-- rows so that every video has one; stage 1 overwrites it with the authoritative
	-- contentDetails.duration (an ISO 8601 period, parsed on the way in), and
	-- `api_fetched_at` is what says which of the two you are looking at.
	--
	-- It is a column rather than something read off a watch row because watch rows of the
	-- SAME video can disagree — one entry scraped a duration, another did not, which is the
	-- state ~231 rows of the archive are in. is_short is a property of the video, so two
	-- watches of it must not be able to answer differently.
	"duration_seconds" integer,
	"title" text,
	"channel_id" text,
	"channel_title" text,
	"category_id" text,
	"api_fetched_at" timestamp with time zone,
	-- videos.list returned no entry for this id: deleted, private, or region-blocked. The
	-- API omits such ids SILENTLY rather than erroring, so absence from the response is the
	-- only signal there is, and it has to be recorded or the id is indistinguishable from
	-- one that was never asked about.
	"api_missing" boolean DEFAULT false NOT NULL,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "youtube_videos_is_short_idx" ON "youtube_videos" USING btree ("is_short");
--> statement-breakpoint
-- Serves the by-method breakdown in get_youtube_stats — "known versus guessed".
CREATE INDEX "youtube_videos_method_idx" ON "youtube_videos" USING btree ("is_short_method");
--> statement-breakpoint
-- Stage 0's work queue: everything never examined. PARTIAL, so once the archive is settled
-- it holds nothing and "safe to run when there is nothing to do" costs a single index probe
-- rather than a scan of 92k rows.
CREATE INDEX "youtube_videos_unexamined_idx" ON "youtube_videos" USING btree ("video_id") WHERE "youtube_videos"."is_short_checked_at" IS NULL;
--> statement-breakpoint
-- Stage 1 and 2's work queue: everything still without a verdict, FEWEST ATTEMPTS FIRST.
--
-- The ordering is not cosmetic. sync-neodb-metadata.ts builds its todo list in JS by
-- subtracting fresh rows from an unordered set, which means a permanently-failing prefix
-- longer than the per-run cap is retried on every pass forever while the rest never come
-- up. sync-stations.ts does it the right way — in SQL, ORDER BY attempts ASC — and that is
-- what this index is for.
--
-- The partial predicate is what makes "never retry the unclassifiable" structural: a row
-- with a method is not in the index at all, so no query can accidentally select it.
CREATE INDEX "youtube_videos_pending_idx" ON "youtube_videos" USING btree ("is_short_attempts","video_id") WHERE "youtube_videos"."is_short_method" IS NULL;
