ALTER TABLE "book_metadata" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_metadata" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
-- Partial on purpose. Hidden rows are the rare case and every public read is
-- `hidden_at IS NULL`, which an index over a mostly-NULL column cannot help with anyway.
-- Indexing only the hidden set keeps the admin's "show hidden" view cheap without
-- carrying dead index weight on the hot path.
CREATE INDEX "book_metadata_hidden_idx" ON "book_metadata" USING btree ("hidden_at") WHERE "hidden_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_metadata_hidden_idx" ON "catalog_metadata" USING btree ("hidden_at") WHERE "hidden_at" IS NOT NULL;
