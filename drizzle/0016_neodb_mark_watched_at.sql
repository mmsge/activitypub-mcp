ALTER TABLE "neodb_marks" ADD COLUMN "watched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "neodb_marks_watched_at_idx" ON "neodb_marks" USING btree ("watched_at");