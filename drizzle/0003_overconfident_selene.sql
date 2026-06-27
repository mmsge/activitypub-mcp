CREATE TABLE "train_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_station" text NOT NULL,
	"to_station" text NOT NULL,
	"journey" text,
	"train_code" text,
	"line_number" text,
	"train_name" text,
	"operator" text,
	"mode" text,
	"travel_class" text,
	"seat_type" text,
	"seat" text,
	"coach" text,
	"reason" text,
	"continent" text,
	"notes" text,
	"ticket" text,
	"departure_local" timestamp NOT NULL,
	"arrival_local" timestamp,
	"from_tz" text,
	"to_tz" text,
	"departure_at" timestamp with time zone NOT NULL,
	"arrival_at" timestamp with time zone,
	"distance_km" integer,
	"delay" integer,
	"departure_delay" integer,
	"price" numeric,
	"savings" numeric,
	"currency" text,
	"cycling" boolean DEFAULT false NOT NULL,
	"wifi" boolean DEFAULT false NOT NULL,
	"dining_car" boolean DEFAULT false NOT NULL,
	"night" boolean DEFAULT false NOT NULL,
	"replacement" boolean DEFAULT false NOT NULL,
	"reservation" boolean DEFAULT false NOT NULL,
	"status" text,
	"tags" text[],
	"raw" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "train_trips_departure_idx" ON "train_trips" USING btree ("departure_at");--> statement-breakpoint
CREATE INDEX "train_trips_status_idx" ON "train_trips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "train_trips_journey_idx" ON "train_trips" USING btree ("journey");--> statement-breakpoint
CREATE INDEX "train_trips_operator_idx" ON "train_trips" USING btree ("operator");--> statement-breakpoint
CREATE UNIQUE INDEX "train_trips_dedupe_idx" ON "train_trips" USING btree ("dedupe_key");