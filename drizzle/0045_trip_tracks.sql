-- Trip geometry and station waypoints from viaduct.world's GPX export, uploaded at
-- Admin → Import. See ADR 0070.
--
--   * One `trip_tracks` row per leg, keyed on viaduct's own trip id, which the CSV export
--     never carries. Matched to `train_trips` at query time on
--     (from_station, to_station, departure_local), so there is no foreign key to go stale.
--   * `segments` is GeoJSON MultiLineString coordinates, [[[lon, lat], …], …].
--   * The GPX is the complete set: an import replaces both tables, and the importer
--     refuses a file with no tracks rather than emptying them.
--   * `viaduct_waypoints` is what viaduct believes a station's coordinates are. It never
--     touches `stations`, which is the geocoder's and the admin's.
CREATE TABLE "trip_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viaduct_trip_id" text NOT NULL,
	"from_station" text NOT NULL,
	"to_station" text NOT NULL,
	"departure_local" timestamp NOT NULL,
	"segments" jsonb NOT NULL,
	"point_count" integer NOT NULL,
	"segment_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trip_tracks_viaduct_trip_idx" ON "trip_tracks" USING btree ("viaduct_trip_id");
--> statement-breakpoint
CREATE INDEX "trip_tracks_identity_idx" ON "trip_tracks" USING btree ("from_station","to_station","departure_local");
--> statement-breakpoint
CREATE TABLE "viaduct_waypoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "viaduct_waypoints_identity_idx" ON "viaduct_waypoints" USING btree ("name","latitude","longitude");
