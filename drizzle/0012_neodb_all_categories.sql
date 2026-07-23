ALTER TABLE "catalog_metadata" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "source_map" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "bookwyrm_book_url" text;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "fetch_error" text;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "fetch_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "catalog_metadata_bookwyrm_idx" ON "catalog_metadata" USING btree ("bookwyrm_book_url");--> statement-breakpoint
-- Rows enriched before this migration succeeded (they only exist because a fetch
-- returned data); seed enriched_at so the staleness/retry logic and the tools treat
-- them as already-populated rather than never-enriched.
UPDATE "catalog_metadata" SET "enriched_at" = "fetched_at" WHERE "enriched_at" IS NULL;