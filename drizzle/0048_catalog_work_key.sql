-- One work per title, whichever NeoDB instance marked it. See ADR 0075.
--
-- Every existing row starts as its own work, keyed on its own URL, so nothing is merged
-- until `npm run backfill-work-keys` groups them. A migration cannot run the grouping:
-- it is a union-find over TMDB links and IMDb ids with a season rule, and it lives in
-- `src/lib/work-key.ts` so the upsert and the backfill share one spelling of it.
ALTER TABLE "catalog_metadata" ADD COLUMN "work_key" text;
--> statement-breakpoint
UPDATE "catalog_metadata" SET "work_key" = 'url:' || "item_url" WHERE "work_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "catalog_metadata" ALTER COLUMN "work_key" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "catalog_metadata_work_key_idx" ON "catalog_metadata" USING btree ("work_key");
