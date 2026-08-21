-- The convergence watcher: when the cumulative scrobble count and the cumulative train
-- kilometres meet, or swap places. See decision record 0056.
--
-- Two counters over the same decade of archive, and the notification has to be prompt
-- because the window can be minutes wide. They have met once — 2020-01-11, 3,298 each,
-- level for three minutes and ten seconds — and nobody noticed until it was months in
-- the past.
--
-- The table below IS the "already announced" bookkeeping. Two things about its shape
-- are load-bearing:
--
--   the key is (kind, occurred_at)   The crossing's own instant, never a row id. A leg
--                                    re-imported from a fresh viaduct export gets a new
--                                    uuid for the same journey, and the post-import walk
--                                    re-derives the same crossings from the same data.
--                                    Keyed on an id, both would read as new and push
--                                    again. The instant is what the crossing IS.
--
--   occurred_at is the CAUSE's time  A scrobble's played_at, a leg's departure_at —
--                                    never when the watcher looked. A backfilled export
--                                    can put a crossing years in the past, and the push
--                                    must carry the date it happened. `historical` is
--                                    what turns the copy into the past tense.
CREATE TABLE "convergence_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

	-- 'equality'  — the two were exactly level.
	-- 'crossover' — the lead changed hands WITHOUT ever being level. Only a kilometre
	--               lump can do that: a scrobble steps by exactly one, so it always
	--               visits zero on the way past and produces an equality instead.
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,

	-- The shared figure, for an equality. Null on a crossover, which by definition has
	-- no single value.
	"value" bigint,
	-- km − scrobbles immediately after the event. Zero on an equality.
	"gap" integer NOT NULL,
	-- 'km' | 'scrobbles' | 'tie'
	"leader" text NOT NULL,
	"scrobbles" bigint NOT NULL,
	"km" bigint NOT NULL,

	-- What moved the number. 'scrobble' fills the artist/track/album/url columns;
	-- 'leg' fills from/to/journey/km.
	"cause_kind" text NOT NULL,
	"cause_artist" text,
	"cause_track" text,
	"cause_album" text,
	"cause_url" text,
	"cause_from" text,
	"cause_to" text,
	"cause_journey" text,
	"cause_km" integer,

	-- Equality only: when the two stopped being level. Null while the window is still
	-- open, and filled in later WITHOUT a second push — one crossing is one
	-- notification, so the close is recorded rather than announced.
	"ended_at" timestamp with time zone,

	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The crossing predated what the watcher already knew: an import rewrote history
	-- under it.
	"historical" boolean DEFAULT false NOT NULL,
	-- Set once the push actually went out. Null means recorded but never announced,
	-- which is what a failed ntfy publish leaves behind.
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The exactly-once enforcement. The job inserts ON CONFLICT DO NOTHING RETURNING and
-- pushes only for the rows that actually came back, so re-evaluating inside an open
-- equality window — or oscillating across zero inside one import — cannot notify twice.
CREATE UNIQUE INDEX "convergence_events_identity_idx" ON "convergence_events" ("kind","occurred_at");
--> statement-breakpoint
CREATE INDEX "convergence_events_occurred_idx" ON "convergence_events" ("occurred_at");
--> statement-breakpoint
-- Where the last evaluation left off. Exactly one row, held there by the unique index
-- on a constant column.
--
-- The totals are the two counters as of `watermark_at`, so the 60-second tick reads
-- only the handful of scrobbles that landed since instead of walking ~52,000 rows every
-- minute. That shortcut is sound for scrobbles and NOT for legs: sync-scrobbles cursors
-- on max(uts) + 1 and can never ingest a play older than the newest one stored, while a
-- viaduct import can insert, correct or delete a leg anywhere in the past. Which is why
-- the import path recomputes from zero rather than trusting this row.
CREATE TABLE "convergence_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"scrobbles" bigint NOT NULL,
	"km" bigint NOT NULL,
	"watermark_at" timestamp with time zone,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "convergence_state_singleton_idx" ON "convergence_state" ("singleton");
