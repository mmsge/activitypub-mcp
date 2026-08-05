-- Bind each post to the train trip it was posted on.
--
-- The archive holds 229 trips (from viaduct.world CSV exports) and 5,096 posts on
-- the same timeline, with nothing joining them — even though a large share of the
-- posts were written on those trips. The `#togselfie` habit is already a check-in
-- stream: measured against the live archive, four of four togselfies land within
-- six minutes of their trip's departure, one of them within 14 seconds.
--
-- There is no id, geotag or text field linking the two sides. The only key is
-- time, and it is a sound one: `objects.published_at` and
-- `train_trips.departure_at`/`arrival_at` are all timestamptz, so the comparison
-- holds across the several timezones the trips span.
--
--   relation        'boarding' (the 30 min before departure — platform time),
--                   'aboard'   (between departure and arrival), or
--                   'alighting' (the 30 min after arrival)
--   offset_seconds  signed seconds from the trip's departure; negative while
--                   still boarding. Stored so a consumer can see how good the
--                   match was rather than trusting the label alone.
--
-- A derived table rather than a column on either side, for the reason ADR 0020
-- kept `derived_date` off `note_date`: `published_at` is what Mastodon recorded,
-- the trip is what we worked out, and re-tuning the match must never be
-- indistinguishable from ingested fact.
--
-- `object_ap_id` is UNIQUE: consecutive legs overlap at the edges, so a post can
-- fall in two windows, but "which train was I on" has one answer. The matcher's
-- ranking in src/lib/trip-window.ts is total, so it is always the same answer.
CREATE TABLE "trip_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"object_ap_id" text NOT NULL,
	"relation" text NOT NULL,
	"offset_seconds" integer NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "trip_posts" ADD CONSTRAINT "trip_posts_trip_id_train_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."train_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_posts" ADD CONSTRAINT "trip_posts_object_ap_id_objects_ap_id_fk" FOREIGN KEY ("object_ap_id") REFERENCES "public"."objects"("ap_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_posts_object_idx" ON "trip_posts" USING btree ("object_ap_id");--> statement-breakpoint
CREATE INDEX "trip_posts_trip_idx" ON "trip_posts" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_posts_relation_idx" ON "trip_posts" USING btree ("relation");
