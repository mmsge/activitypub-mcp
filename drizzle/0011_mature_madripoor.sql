CREATE TABLE "catalog_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_url" text NOT NULL,
	"category" text,
	"item_type" text,
	"title" text,
	"display_title" text,
	"orig_title" text,
	"description" text,
	"cover_url" text,
	"imdb" text,
	"imdb_url" text,
	"tmdb_url" text,
	"external_resources" jsonb,
	"year" integer,
	"season_number" integer,
	"episode_count" integer,
	"genre" jsonb,
	"director" jsonb,
	"actors" jsonb,
	"language" jsonb,
	"area" jsonb,
	"rating" numeric(3, 1),
	"parent_uuid" text,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_metadata_item_url_unique" UNIQUE("item_url")
);
--> statement-breakpoint
CREATE INDEX "catalog_metadata_item_url_idx" ON "catalog_metadata" USING btree ("item_url");--> statement-breakpoint
CREATE INDEX "catalog_metadata_category_idx" ON "catalog_metadata" USING btree ("category");--> statement-breakpoint
CREATE INDEX "catalog_metadata_imdb_idx" ON "catalog_metadata" USING btree ("imdb");