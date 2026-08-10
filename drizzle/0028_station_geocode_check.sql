-- How far a station's coordinates disagree with the trips that pass through it.
--
-- A geocoded station name is right most of the time and confidently wrong the
-- rest, with no signal either way: the lookup succeeds and the weather quietly
-- comes from the wrong country. Six of Markus' stations were placed in France
-- this way — Arna above Nice, Bergen in the Somme (ADR 0029).
--
-- The archive can check the work. viaduct.world records `distance_km` per leg,
-- and a straight line can never be longer than the distance travelled, so a leg
-- recorded as 9 km whose endpoints are 1,900 km apart has a station in the wrong
-- place. `geocode_error_km` is the worst such excess across the station's legs:
-- null when unchecked or uncheckable, near zero or negative when fine, and large
-- when the coordinates are wrong. Written by jobs/check-station-geocodes.ts.
ALTER TABLE "stations" ADD COLUMN "geocode_error_km" numeric;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "geocode_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "stations_geocode_error_idx" ON "stations" USING btree ("geocode_error_km");
