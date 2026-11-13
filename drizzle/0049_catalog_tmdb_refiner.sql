-- English metadata from TMDB for film and TV (ADR 0076).
--
-- `tmdb_refined_at` is set when the last enrichment pass took fields from TMDB, and is
-- cleared by any pass that did not, so it never claims a refinement NeoDB's values have
-- since overwritten. `tmdb_error` + `tmdb_attempts` mirror `fetch_error` +
-- `fetch_attempts`: a failed TMDB call never blocks the row, it is retried later.
-- `tmdb_raw` keeps TMDB's responses as delivered.
ALTER TABLE "catalog_metadata" ADD COLUMN "tmdb_refined_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "tmdb_error" text;
--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "tmdb_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "tmdb_raw" jsonb;
