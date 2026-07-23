ALTER TABLE "catalog_metadata" ADD COLUMN "mark_titles" jsonb;--> statement-breakpoint
-- Backfill the ActivityPub-supplied aliases that enrichment discarded: for each
-- catalogue row, the distinct non-empty tag `name`s from every stored mark whose tag
-- `href` is this row's item_url (NeoDB media tags, plus `Edition` tags from NeoDB
-- actors). This is what makes a title findable by the name the mark federated with
-- (e.g. "Conflict") even after enrichment overwrote the title with the localized
-- "Konflikt". Ordered for stable output; mirrors the app's markTitlesForUrl query.
UPDATE "catalog_metadata" cm
SET "mark_titles" = names.arr
FROM (
  SELECT tag->>'href' AS item_url,
         jsonb_agg(DISTINCT tag->>'name' ORDER BY tag->>'name') AS arr
  FROM "objects" o
  JOIN "actors" a ON a.ap_id = o.actor_ap_id,
       jsonb_array_elements(o.tags) AS tag
  WHERE jsonb_typeof(o.tags) = 'array'
    AND tag->>'href' IS NOT NULL AND tag->>'href' <> ''
    AND tag->>'name' IS NOT NULL AND tag->>'name' <> ''
    AND (
      tag->>'type' IN ('Movie','TVShow','TVSeason','TVEpisode','Album','Game','Podcast','Performance','PerformanceProduction')
      OR (tag->>'type' = 'Edition' AND a.software = 'neodb')
    )
  GROUP BY tag->>'href'
) AS names
WHERE cm."item_url" = names.item_url
  AND names.arr IS NOT NULL
  AND jsonb_array_length(names.arr) > 0;--> statement-breakpoint
-- Record provenance so source_map distinguishes the alias origin from the NeoDB fields.
UPDATE "catalog_metadata"
SET "source_map" = coalesce("source_map", '{}'::jsonb) || '{"mark_titles":"activitypub"}'::jsonb
WHERE "mark_titles" IS NOT NULL
  AND jsonb_typeof("mark_titles") = 'array'
  AND jsonb_array_length("mark_titles") > 0;
