-- The weather at a station, on the day Markus was there.
--
-- The archive can already say he took the Bergensbanen on 5 June 2026 and what he
-- posted from it. It cannot say it was raining. Two tables close that, and they are
-- separate because they fail separately: geocoding a station is a one-off lookup
-- against OpenStreetMap, while the weather is a per-date fetch against Open-Meteo's
-- ERA5 archive. A station that will not geocode should not keep re-requesting
-- weather, and a weather outage should not cost us the coordinates.
--
--   stations           one row per distinct station name in train_trips, with the
--                      coordinates it geocoded to. `display_name` is what the
--                      geocoder actually matched, kept so a wrong hit ("Bergen" in
--                      Germany rather than Norway) is visible rather than silently
--                      wrong. `source` marks a hand-corrected row so the job never
--                      overwrites a fix.
--
--   station_weather    one row per (station, date). Daily aggregates only — the
--                      question is "what was it like that day", not an hourly trace.
--
-- Precision is deliberately not chased. ERA5 is a reanalysis on a ~25 km grid, so
-- landing in the right town is as good as landing on the right platform; a
-- geocode that is a kilometre off reads the same cell. That is why a bare name
-- lookup, biased by the country the trip's timezone implies, is enough.
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"latitude" numeric,
	"longitude" numeric,
	"display_name" text,
	"country_code" text,
	-- 'nominatim' | 'manual'. A manual row is never re-geocoded.
	"source" text DEFAULT 'nominatim' NOT NULL,
	"geocoded_at" timestamp with time zone,
	-- Attempt bookkeeping, so a name that cannot be found is retried a few times
	-- and then left alone rather than hammered on every scheduler tick.
	"last_attempt_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "station_weather" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"date" date NOT NULL,
	"temp_max_c" numeric,
	"temp_min_c" numeric,
	"temp_mean_c" numeric,
	"precipitation_mm" numeric,
	"snowfall_cm" numeric,
	"wind_max_kmh" numeric,
	-- WMO code (0 clear … 75 heavy snow). Rendered to Nynorsk by weather-code.ts.
	"weather_code" integer,
	"source" text DEFAULT 'open-meteo' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "station_weather" ADD CONSTRAINT "station_weather_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stations_name_idx" ON "stations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "stations_geocoded_idx" ON "stations" USING btree ("geocoded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "station_weather_station_date_idx" ON "station_weather" USING btree ("station_id","date");--> statement-breakpoint
CREATE INDEX "station_weather_date_idx" ON "station_weather" USING btree ("date");
