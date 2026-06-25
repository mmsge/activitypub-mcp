CREATE TABLE "scrobbles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"artist_mbid" text,
	"album_name" text,
	"album_mbid" text,
	"track_mbid" text,
	"track_url" text,
	"image_url" text,
	"played_at" timestamp with time zone NOT NULL,
	"uts" bigint NOT NULL,
	"loved" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scrobbles_played_idx" ON "scrobbles" USING btree ("played_at");--> statement-breakpoint
CREATE INDEX "scrobbles_artist_idx" ON "scrobbles" USING btree ("artist_name");--> statement-breakpoint
CREATE INDEX "scrobbles_album_idx" ON "scrobbles" USING btree ("album_name");--> statement-breakpoint
CREATE INDEX "scrobbles_track_idx" ON "scrobbles" USING btree ("track_name");--> statement-breakpoint
CREATE INDEX "scrobbles_uts_idx" ON "scrobbles" USING btree ("uts");--> statement-breakpoint
CREATE UNIQUE INDEX "scrobbles_dedupe_idx" ON "scrobbles" USING btree ("played_at","track_name","artist_name");