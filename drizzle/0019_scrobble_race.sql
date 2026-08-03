CREATE TABLE "scrobble_race_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leader_artist" text NOT NULL,
	"challenger_artist" text NOT NULL,
	"leader_plays" integer NOT NULL,
	"challenger_plays" integer NOT NULL,
	"last_milestone" integer,
	"last_announced_gap" integer,
	"overtaken_at" timestamp with time zone,
	"last_nowplaying_key" text,
	"last_nowplaying_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scrobble_race_pair_idx" ON "scrobble_race_state" USING btree ("leader_artist","challenger_artist");