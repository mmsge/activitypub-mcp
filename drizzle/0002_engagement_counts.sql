ALTER TABLE "objects" ADD COLUMN "likes_count" integer;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "boosts_count" integer;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "replies_count" integer;--> statement-breakpoint
CREATE INDEX "objects_likes_count_idx" ON "objects" USING btree ("likes_count");--> statement-breakpoint
CREATE INDEX "objects_boosts_count_idx" ON "objects" USING btree ("boosts_count");--> statement-breakpoint
CREATE INDEX "objects_replies_count_idx" ON "objects" USING btree ("replies_count");--> statement-breakpoint
UPDATE "objects" SET
  "likes_count" = COALESCE(
    CASE WHEN jsonb_typeof(raw->'likes') = 'object' AND (raw->'likes'->>'totalItems') ~ '^[0-9]+$' THEN (raw->'likes'->>'totalItems')::int END,
    CASE WHEN jsonb_typeof(raw->'likes') = 'number' AND (raw->>'likes') ~ '^[0-9]+$' THEN (raw->>'likes')::int END,
    CASE WHEN (raw->>'favouritesCount') ~ '^[0-9]+$' THEN (raw->>'favouritesCount')::int END,
    CASE WHEN (raw->>'favourites_count') ~ '^[0-9]+$' THEN (raw->>'favourites_count')::int END
  ),
  "boosts_count" = COALESCE(
    CASE WHEN jsonb_typeof(raw->'shares') = 'object' AND (raw->'shares'->>'totalItems') ~ '^[0-9]+$' THEN (raw->'shares'->>'totalItems')::int END,
    CASE WHEN jsonb_typeof(raw->'shares') = 'number' AND (raw->>'shares') ~ '^[0-9]+$' THEN (raw->>'shares')::int END,
    CASE WHEN (raw->>'reblogsCount') ~ '^[0-9]+$' THEN (raw->>'reblogsCount')::int END,
    CASE WHEN (raw->>'sharesCount') ~ '^[0-9]+$' THEN (raw->>'sharesCount')::int END,
    CASE WHEN (raw->>'shares_count') ~ '^[0-9]+$' THEN (raw->>'shares_count')::int END
  ),
  "replies_count" = COALESCE(
    CASE WHEN jsonb_typeof(raw->'replies') = 'object' AND (raw->'replies'->>'totalItems') ~ '^[0-9]+$' THEN (raw->'replies'->>'totalItems')::int END,
    CASE WHEN jsonb_typeof(raw->'replies') = 'number' AND (raw->>'replies') ~ '^[0-9]+$' THEN (raw->>'replies')::int END,
    CASE WHEN (raw->>'repliesCount') ~ '^[0-9]+$' THEN (raw->>'repliesCount')::int END,
    CASE WHEN (raw->>'replies_count') ~ '^[0-9]+$' THEN (raw->>'replies_count')::int END
  );
