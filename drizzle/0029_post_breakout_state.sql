-- Per-post state for the breakout notifier: which of Markus' posts have been
-- announced as doing unusually well, and how far up the ladder each one got.
--
-- The bot has been sampling favourites/boosts/replies into `engagement_snapshots` for
-- months, but nothing ever read them back and said "this one is doing better than your
-- usual". This table is the memory that makes such an announcement safe to send
-- exactly once.
--
-- One row per post, NOT per (post, rung). The three rungs — past the p90 of that
-- actor's own recent posts, past p99, a personal best — are a ladder, and `rung` only
-- ever ratchets upward. A post that has already taken the record cannot announce
-- "past your p90" again however the numbers move afterwards.
--
-- Four choices here are non-obvious enough that a later, well-meaning edit would
-- plausibly reverse them.
--
--   `peak_score`, not `score`, is what the ladder is evaluated against. Engagement
--   counts go DOWN — engagement_snapshots says so in its own comment, and negative
--   deltas there are correct rather than corruption. An un-favourite must not be able
--   to un-fire a rung, re-arm one, or lower the personal best that every other post is
--   measured against. `score` is stored anyway because the gap between "doing now" and
--   "peaked at" is the interesting part, and because an unchanged score short-circuits
--   the whole decision.
--
--   the three *_at columns are NULLABLE, and stay NULL when a rung was pre-marked at
--   SEED time rather than announced. This is the only reason switching the feature on
--   does not replay a year of history into his phone as a notification storm: the
--   first sighting of a post records where it already is and says nothing. "Has this
--   ever actually been announced?" has to be answerable, and `rung` alone cannot
--   answer it.
--
--   `weights_key` fingerprints the BREAKOUT_WEIGHT_* values. Changing one weight
--   re-scores the entire archive in a single tick, which without this guard would look
--   exactly like fifty posts breaking out in the same minute. A key mismatch is
--   treated as a first sighting: recompute, pre-mark, persist, send nothing.
--
--   there is NO foreign key to objects.ap_id, matching engagement_snapshots. A
--   delete-and-re-ingest cycle must not cascade away a latch — that would turn one
--   edited post into a repeat announcement.
--
-- The daily digest's cursor is deliberately not here: "when did the summary last go
-- out" is one timestamp, and `server_config` is already a key/value store, so it lives
-- there under `breakout_digest_last_sent_at` and costs no DDL.
--
-- See ADR 0036.
CREATE TABLE "post_breakout_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_ap_id" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	-- Latest observed score; also the dedupe key for an unchanged tick.
	"score" integer NOT NULL,
	-- High-water mark. Monotone up. This is what the rungs are judged against.
	"peak_score" integer NOT NULL,
	-- null | 'p90' | 'p99' | 'best'. One-way.
	"rung" text,
	-- The score at which `rung` was reached, so the digest quotes what was announced
	-- rather than a number that may have moved between the push and the summary.
	"rung_score" integer,
	-- When each rung was ANNOUNCED. NULL = never announced (not reached, or reached
	-- before this post was first seen and therefore pre-marked in silence).
	"p90_at" timestamp with time zone,
	"p99_at" timestamp with time zone,
	"best_at" timestamp with time zone,
	"weights_key" text NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "post_breakout_state_status_ap_id_unique" ON "post_breakout_state" USING btree ("status_ap_id");
--> statement-breakpoint
-- "What crossed a rung today" (the digest) and the same question per account (admin).
CREATE INDEX "post_breakout_actor_idx" ON "post_breakout_state" USING btree ("actor_ap_id","updated_at");
