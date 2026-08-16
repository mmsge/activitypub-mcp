-- YouTube watch events, ingested from a Google Takeout-shaped `watch-history.json`.
--
-- One row per watch, not per video: ~96k watches over ~92k distinct videos. It is an
-- append-only time series, the same shape as `scrobbles`, and it is read the same way —
-- a paginated feed plus an aggregate. See ADR 0047.
--
-- Deliberately NOT the place for enrichment. Category, tags and canonical channel
-- metadata are properties of a VIDEO, and denormalising them here would mean rewriting
-- ~96k rows to set a field that has ~92k distinct values. They belong in a future
-- `youtube_videos` table keyed on `video_id`, joined at query time. `video_id` is
-- indexed below to be that join key.
CREATE TABLE "youtube_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Which Google account watched it ('mvrkws' | 'rawen100'). Plain text rather than
	-- an enum: a third account must not require a migration. The two accounts OVERLAP
	-- in time — this is not a switchover on a single date — so nothing may assume one
	-- account's range ends where the other's begins.
	"account" text NOT NULL,
	-- The 11-character video id, extracted from `?v=` or `/shorts/`. This is the
	-- video's identity and one third of the dedupe key.
	"video_id" text NOT NULL,
	-- `titleUrl` verbatim, kept so the row can be traced back to the source line
	-- without reconstructing a URL from the id.
	"video_url" text NOT NULL,
	-- THE AUTHORITY. The source records a bare local wall clock — Europe/Oslo, no
	-- offset, minute resolution, seconds always 00 — so it is stored exactly as
	-- delivered, in a timestamp WITHOUT time zone. A naive parse would read it as UTC
	-- and shift every row by an hour or two.
	--
	-- Everything calendar-shaped reads this column: year/month/hour-of-day buckets and
	-- the from/to/year filters. A bucket computed here needs no AT TIME ZONE at all, so
	-- it cannot be double-converted, and `year=2025` reproduces the source's own
	-- per-year counts exactly rather than misfiling the hours either side of New Year.
	"watched_at_local" timestamp NOT NULL,
	-- Derived from watched_at_local at insert with `AT TIME ZONE 'Europe/Oslo'`, the
	-- same two-column shape train_trips uses for departure_local / departure_at. This
	-- is the instant, for cross-source joins against scrobbles/gigs/trips and for
	-- ORDER BY + keyset pagination.
	--
	-- The source carries no offset, so a watch in the repeated hour of the autumn
	-- fall-back resolves to the earlier of the two possible instants. That costs at
	-- most one collapsed row per year, and only if the same video was watched twice
	-- inside that repeated minute. Accepted, and recorded rather than hidden.
	"watched_at" timestamp with time zone NOT NULL,
	-- The video title with the source's "Watched " prefix stripped. NULL when the row
	-- is unresolved — for those the source puts the bare URL in the title field, which
	-- is not a title and must not be stored as one.
	"title" text,
	-- Channel display name, from subtitles[0].name. NULL when unresolved.
	"channel_name" text,
	-- The UC… channel id from subtitles[0].url. NULL when unresolved, and also NULL
	-- when the source gave an @handle URL instead. Stored beside the name because a
	-- channel that renames keeps one id and acquires two names: counting distinct
	-- channels by name would split it, and would merge two channels sharing a name.
	"channel_id" text,
	-- The VIDEO's length in seconds, scraped from the page — NEVER how much of it was
	-- watched. No watch duration exists anywhere in Takeout or My Activity; the data
	-- records only that the video was opened. Every "hours watched" figure derived
	-- from this column is a strict UPPER BOUND, which is why get_youtube_stats returns
	-- three differently-qualified estimates instead of one number.
	--
	-- NULL on ~11% of rows (unresolved videos and a handful of live streams). A NULL
	-- here is UNKNOWN, not zero and not long-form — the Shorts heuristic below cannot
	-- classify it either way.
	"duration_seconds" integer,
	-- TERMINAL. Marks a deleted, private or otherwise unavailable video: no title, no
	-- channel. These are real watch events and are kept, but a future enrichment pass
	-- must never retry them, or it will spend its daily quota re-discovering that ~11%
	-- of the archive is still dead.
	"unresolved" boolean DEFAULT false NOT NULL,
	-- Provenance: 'myactivity-console' for the My Activity scrape, a different value
	-- for a real Takeout export. Kept verbatim per row so a merged file's halves stay
	-- distinguishable after the fact.
	"source" text NOT NULL,
	-- The source entry exactly as delivered, so a re-parse never needs the file back.
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "youtube_watches_watched_idx" ON "youtube_watches" USING btree ("watched_at");
--> statement-breakpoint
CREATE INDEX "youtube_watches_watched_local_idx" ON "youtube_watches" USING btree ("watched_at_local");
--> statement-breakpoint
CREATE INDEX "youtube_watches_account_idx" ON "youtube_watches" USING btree ("account");
--> statement-breakpoint
CREATE INDEX "youtube_watches_channel_idx" ON "youtube_watches" USING btree ("channel_id");
--> statement-breakpoint
CREATE INDEX "youtube_watches_channel_name_idx" ON "youtube_watches" USING btree ("channel_name");
--> statement-breakpoint
-- The join key for the future youtube_videos enrichment table, and for "how many times
-- did I watch this one video".
CREATE INDEX "youtube_watches_video_idx" ON "youtube_watches" USING btree ("video_id");
--> statement-breakpoint
-- Serves the Shorts heuristic (duration < 180s) and the long-form split.
CREATE INDEX "youtube_watches_duration_idx" ON "youtube_watches" USING btree ("duration_seconds");
--> statement-breakpoint
-- Takeout has no watch id, so (account, video, wall-clock minute) is the natural key,
-- and all three parts are load-bearing:
--
--   * a video is legitimately rewatched — 3,530 of them more than once, one 24 times;
--   * one minute legitimately holds up to 31 DIFFERENT videos, because minute
--     resolution plus rapid Shorts scrolling collide — 15,782 timestamps carry more
--     than one entry for the same account;
--   * two accounts can hold the same video in the same minute.
--
-- Dropping any part collapses real, distinct watch events. Keying on watched_at_local
-- rather than the instant also makes the constraint immune to how the DST fall-back
-- hour is resolved: it is the source's own key, byte for byte.
CREATE UNIQUE INDEX "youtube_watches_dedupe_idx" ON "youtube_watches" USING btree ("account","video_id","watched_at_local");
