-- A trip's identity is when it left and between where — not which train ran it.
--
-- Until now identity was a SHA-256 of `from | to | departure_local | train_code |
-- journey`, applied with ON CONFLICT DO NOTHING. Train code is in that key and is not
-- stable: viaduct exports a leg with no code while it is planned and with one once it
-- has been travelled, and two sources describe the same service differently (`RER A`
-- vs `18568` for a Paris RER leg, `S S3` vs `3089` in Berlin). Same physical journey,
-- two hashes, two rows. ADR 0031 diagnosed the other half — nothing but the key is in
-- the key, so DO NOTHING made every other column write-once and `status` could never
-- be corrected. ADR 0048 replaces both.
--
-- On 16 August 2026 this table held 165 rows for 2026 describing ~88 real legs. Every
-- duplicate pair agreed on journey, instant and both stations, and differed only in
-- train code and sometimes distance. Two of them decide the merge rule:
--
--   Kaizershausten 26, København → Praha: `1176 km / no code` and `1172 km / RJ 385`.
--     Both distances non-null, so "keep the richest" needs a stated tiebreak.
--   Torucon 2026, Bergen → Oslo S: the train code `D 606` sits on the *Planned* copy
--     and is null on the *Completed* one. So the merge cannot prefer the completed row
--     wholesale — it has to be per attribute.
--
-- Hence: rank the group (most advanced status, then having a train code, then newest),
-- and take the FIRST NON-NULL value of each column in that order. Status is the most
-- advanced in the group regardless of which row won. `raw` is left exactly as
-- delivered — provenance that has been edited is not provenance (the rule
-- src/jobs/rebase-gig-origin.ts records).
--
-- The collapse lives in the same migration as the unique index deliberately. Migrations
-- run at container start (Dockerfile ENTRYPOINT), so a migration that only added the
-- index would abort the boot on any database that still holds a duplicate pair.
--
-- `train_trips_pre_dedupe` is a full snapshot, not just the doomed rows — the surviving
-- rows are mutated too, so only a whole copy makes the pre-state recoverable. It is
-- deliberately absent from src/db/schema.ts; a later migration should drop it once the
-- result has been confirmed in production.
CREATE TABLE "train_trips_pre_dedupe" AS SELECT * FROM "train_trips";--> statement-breakpoint
-- Which row of each duplicate group survives, and where the losers' values go. Groups
-- of one are excluded outright, so a database with no duplicates rewrites nothing.
CREATE TABLE "train_trips_dedupe_plan" AS
WITH "dup" AS (
	SELECT "from_station", "to_station", "departure_at"
	FROM "train_trips"
	GROUP BY "from_station", "to_station", "departure_at"
	HAVING count(*) > 1
)
SELECT
	t."id",
	row_number() OVER w AS "rn",
	first_value(t."id") OVER w AS "winner_id"
FROM "train_trips" t
JOIN "dup" d
	ON d."from_station" = t."from_station"
	AND d."to_station" = t."to_station"
	AND d."departure_at" = t."departure_at"
WINDOW w AS (
	PARTITION BY t."from_station", t."to_station", t."departure_at"
	ORDER BY
		-- Most advanced status first, then the copy that names a train, then the most
		-- recently imported. `id` last so the ranking is total and the migration is
		-- deterministic on a re-run against a restored snapshot.
		(CASE t."status" WHEN 'Completed' THEN 2 WHEN 'Planned' THEN 1 ELSE 0 END) DESC,
		(t."train_code" IS NOT NULL) DESC,
		t."created_at" DESC,
		t."id"
);--> statement-breakpoint
-- Fold every loser's attributes into the winner. `(array_agg(c ORDER BY rn) FILTER
-- (WHERE c IS NOT NULL))[1]` is "the first non-null c in rank order" — the winner's
-- value when it has one, the best-ranked loser's when it does not.
WITH "agg" AS (
	SELECT
		p."winner_id",
		(array_agg(t."journey" ORDER BY p."rn") FILTER (WHERE t."journey" IS NOT NULL))[1] AS "journey",
		(array_agg(t."train_code" ORDER BY p."rn") FILTER (WHERE t."train_code" IS NOT NULL))[1] AS "train_code",
		(array_agg(t."line_number" ORDER BY p."rn") FILTER (WHERE t."line_number" IS NOT NULL))[1] AS "line_number",
		(array_agg(t."train_name" ORDER BY p."rn") FILTER (WHERE t."train_name" IS NOT NULL))[1] AS "train_name",
		(array_agg(t."operator" ORDER BY p."rn") FILTER (WHERE t."operator" IS NOT NULL))[1] AS "operator",
		(array_agg(t."mode" ORDER BY p."rn") FILTER (WHERE t."mode" IS NOT NULL))[1] AS "mode",
		(array_agg(t."travel_class" ORDER BY p."rn") FILTER (WHERE t."travel_class" IS NOT NULL))[1] AS "travel_class",
		(array_agg(t."seat_type" ORDER BY p."rn") FILTER (WHERE t."seat_type" IS NOT NULL))[1] AS "seat_type",
		(array_agg(t."seat" ORDER BY p."rn") FILTER (WHERE t."seat" IS NOT NULL))[1] AS "seat",
		(array_agg(t."coach" ORDER BY p."rn") FILTER (WHERE t."coach" IS NOT NULL))[1] AS "coach",
		(array_agg(t."reason" ORDER BY p."rn") FILTER (WHERE t."reason" IS NOT NULL))[1] AS "reason",
		(array_agg(t."continent" ORDER BY p."rn") FILTER (WHERE t."continent" IS NOT NULL))[1] AS "continent",
		(array_agg(t."notes" ORDER BY p."rn") FILTER (WHERE t."notes" IS NOT NULL))[1] AS "notes",
		(array_agg(t."ticket" ORDER BY p."rn") FILTER (WHERE t."ticket" IS NOT NULL))[1] AS "ticket",
		(array_agg(t."distance_km" ORDER BY p."rn") FILTER (WHERE t."distance_km" IS NOT NULL))[1] AS "distance_km",
		(array_agg(t."delay" ORDER BY p."rn") FILTER (WHERE t."delay" IS NOT NULL))[1] AS "delay",
		(array_agg(t."departure_delay" ORDER BY p."rn") FILTER (WHERE t."departure_delay" IS NOT NULL))[1] AS "departure_delay",
		(array_agg(t."price" ORDER BY p."rn") FILTER (WHERE t."price" IS NOT NULL))[1] AS "price",
		(array_agg(t."savings" ORDER BY p."rn") FILTER (WHERE t."savings" IS NOT NULL))[1] AS "savings",
		(array_agg(t."currency" ORDER BY p."rn") FILTER (WHERE t."currency" IS NOT NULL))[1] AS "currency",
		-- Arrival moves as a unit, keyed on `arrival_at` being present, so the wall
		-- clock, the instant and the zone it was computed in can never come from
		-- different copies and disagree.
		(array_agg(t."arrival_local" ORDER BY p."rn") FILTER (WHERE t."arrival_at" IS NOT NULL))[1] AS "arrival_local",
		(array_agg(t."arrival_at" ORDER BY p."rn") FILTER (WHERE t."arrival_at" IS NOT NULL))[1] AS "arrival_at",
		(array_agg(t."to_tz" ORDER BY p."rn") FILTER (WHERE t."arrival_at" IS NOT NULL))[1] AS "to_tz",
		-- `tags` is text[]; array_agg over an array column builds a 2-D array and
		-- refuses rows of differing length, so the same "first non-null in rank order"
		-- is spelled out as a subquery instead.
		(
			SELECT t2."tags"
			FROM "train_trips_dedupe_plan" p2
			JOIN "train_trips" t2 ON t2."id" = p2."id"
			WHERE p2."winner_id" = p."winner_id" AND t2."tags" IS NOT NULL
			ORDER BY p2."rn"
			LIMIT 1
		) AS "tags",
		-- The most advanced status anywhere in the group, independent of which row won
		-- the ranking — a Planned copy must never pull a travelled leg back.
		max(CASE t."status" WHEN 'Completed' THEN 2 WHEN 'Planned' THEN 1 ELSE 0 END) AS "status_rank",
		-- These are NOT NULL DEFAULT false, so an absent flag reads as false and there
		-- is no null to coalesce through. Any copy claiming the amenity carries it.
		bool_or(t."cycling") AS "cycling",
		bool_or(t."wifi") AS "wifi",
		bool_or(t."dining_car") AS "dining_car",
		bool_or(t."night") AS "night",
		bool_or(t."replacement") AS "replacement",
		bool_or(t."reservation") AS "reservation"
	FROM "train_trips_dedupe_plan" p
	JOIN "train_trips" t ON t."id" = p."id"
	GROUP BY p."winner_id"
)
UPDATE "train_trips" w SET
	"journey" = a."journey",
	"train_code" = a."train_code",
	"line_number" = a."line_number",
	"train_name" = a."train_name",
	"operator" = a."operator",
	"mode" = a."mode",
	"travel_class" = a."travel_class",
	"seat_type" = a."seat_type",
	"seat" = a."seat",
	"coach" = a."coach",
	"reason" = a."reason",
	"continent" = a."continent",
	"notes" = a."notes",
	"ticket" = a."ticket",
	"distance_km" = a."distance_km",
	"delay" = a."delay",
	"departure_delay" = a."departure_delay",
	"price" = a."price",
	"savings" = a."savings",
	"currency" = a."currency",
	"arrival_local" = a."arrival_local",
	"arrival_at" = a."arrival_at",
	"to_tz" = a."to_tz",
	"tags" = a."tags",
	"status" = CASE a."status_rank" WHEN 2 THEN 'Completed' WHEN 1 THEN 'Planned' ELSE NULL END,
	"cycling" = a."cycling",
	"wifi" = a."wifi",
	"dining_car" = a."dining_car",
	"night" = a."night",
	"replacement" = a."replacement",
	"reservation" = a."reservation"
FROM "agg" a
WHERE w."id" = a."winner_id";--> statement-breakpoint
-- The losers. `trip_posts`, `trip_routes` and `trip_line_legs` cascade — all three are
-- derived from the trip rather than ingested with it, and the hourly jobs re-derive
-- them (`npm run link-trip-posts`, `npm run resolve-lines` to do it immediately).
DELETE FROM "train_trips" WHERE "id" IN (SELECT "id" FROM "train_trips_dedupe_plan" WHERE "rn" > 1);--> statement-breakpoint
-- The winners keep their id, so their cached route survives the collapse — and it may
-- now be scaled against a distance that just changed. resolveTripLines only revisits a
-- trip whose trip_routes row is missing or predates the current registry version
-- (src/jobs/resolve-trip-lines.ts), so nothing else would ever recompute `scale_factor`
-- or the per-line kilometres. Drop the cache and let the hourly job rebuild it.
DELETE FROM "trip_routes" WHERE "trip_id" IN (SELECT DISTINCT "winner_id" FROM "train_trips_dedupe_plan");--> statement-breakpoint
DROP TABLE "train_trips_dedupe_plan";--> statement-breakpoint
-- The hash and the tuple are two contradictory notions of identity; keeping both is the
-- foot-gun ADR 0031 flagged. `dedupe_key` has no reader outside the import itself.
DROP INDEX "train_trips_dedupe_idx";--> statement-breakpoint
ALTER TABLE "train_trips" DROP COLUMN "dedupe_key";--> statement-breakpoint
-- `departure_at` is timestamptz — the absolute instant, computed at insert from the
-- local wall clock and the origin's IANA zone. That is the single explicit timezone the
-- comparison happens in, so an offset difference cannot split one trip into two. All
-- three columns are NOT NULL, so a plain unique index needs no NULLS NOT DISTINCT.
CREATE UNIQUE INDEX "train_trips_identity_idx" ON "train_trips" USING btree ("from_station","to_station","departure_at");
