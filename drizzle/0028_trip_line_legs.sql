-- Which named railway lines a trip ran on, and how far along each.
--
-- The trip store knows stations, operators and a distance. It has no concept of a
-- *line*, so "how many kilometres have I done on Bergensbanen?" meant guessing every
-- station on the route, running one query per station, deduplicating by hand and
-- summing columns — and still missing the legs whose endpoints sit off the line.
-- Fixed links were worse: nothing recorded that a trip crossed a bridge at all.
--
-- Two tables, and no registry table, because the curation and the arithmetic are
-- different kinds of thing:
--
--   the registry     which lines exist, where their kilometre posts fall, which
--                    routings are pinned — lives in git as src/lib/railway-registry.ts.
--                    A line's definition is a reviewed code change, not a row someone
--                    edited in place. Same reasoning that keeps the derived post↔trip
--                    join off both its parent tables in ADR 0023.
--
--   trip_routes      one row per trip: did it resolve, by what method, and how far
--                    the registry's kilometres sat from viaduct's recorded distance.
--                    Required — a trip that resolved to nothing and a trip nobody has
--                    resolved yet are different answers, and only a per-trip row tells
--                    them apart. That distinction is the whole basis of the coverage
--                    every response reports.
--
--   trip_line_legs   one row per (trip, line): the portion of that trip on that line,
--                    scaled so the per-line sum equals the recorded distance, with
--                    time prorated by distance share because there are no intermediate
--                    timings to prorate by anything better.
--
-- `registry_version` is a hash of the registry and its overrides. When curation
-- changes, every row computed from the old one is stale and re-resolves; nothing is
-- ever partially migrated. Resolution is pure arithmetic over ~230 trips, so the
-- whole archive recomputes in milliseconds and there is no bounded backfill here.
--
-- See ADR 0035.
CREATE TABLE "trip_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	-- 'resolved' | 'ambiguous' | 'unresolved'
	"status" text NOT NULL,
	-- The one explanation field: why an unresolved trip could not be placed and which
	-- candidates tied for an ambiguous one, or — when curation placed it — the pinned
	-- routing's justification. Surfaced verbatim in the coverage block and alongside
	-- any total an override produced.
	"reason" text,
	-- 'kmposts' | 'override_pair' | 'override_trip'
	"method" text,
	-- The unscaled sum of the registry spans, kept so the scaling is auditable.
	"raw_km" numeric,
	-- distance_km / raw_km. Stored rather than applied silently: the registry's posts
	-- and viaduct's recorded distance are two different measurements, and the gap
	-- between them is what says whether to trust the split.
	"scale_factor" numeric,
	"registry_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "trip_line_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	-- Text, not a foreign key: the registry is a code module, not a table. A slug that
	-- leaves the registry is a curation change, and the resolver rewrites these rows
	-- wholesale when one happens.
	"line_slug" text NOT NULL,
	"on_line_km" numeric NOT NULL,
	"on_line_seconds" integer,
	-- True when this leg traversed a named crossing end to end. Counted per leg, so an
	-- out-and-back day trip over the Øresund bridge is two crossings, not one.
	"crossed" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
ALTER TABLE "trip_routes" ADD CONSTRAINT "trip_routes_trip_id_train_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."train_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_line_legs" ADD CONSTRAINT "trip_line_legs_trip_id_train_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."train_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_routes_trip_idx" ON "trip_routes" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_routes_status_idx" ON "trip_routes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trip_routes_version_idx" ON "trip_routes" USING btree ("registry_version");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_line_legs_trip_line_idx" ON "trip_line_legs" USING btree ("trip_id","line_slug");--> statement-breakpoint
CREATE INDEX "trip_line_legs_line_idx" ON "trip_line_legs" USING btree ("line_slug");--> statement-breakpoint
CREATE INDEX "trip_line_legs_crossed_idx" ON "trip_line_legs" USING btree ("crossed");
