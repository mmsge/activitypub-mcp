-- StoryGraph read dates, from the library export uploaded at Admin → Import. See ADR 0063.
--
-- BookWyrm federates a start only when a "started reading" status was posted, so many
-- books have a finish and no start, and rereads collapse into one window. StoryGraph's
-- export lists every read with both ends. These rows are folded into the derived reading
-- cycles at query time, and BookWyrm's own dates always win.
--
--   * One row per read, per BookWyrm actor. Identity is (actor, book_key, range_key), so
--     re-importing the same file writes nothing and a reread is its own row.
--   * `started_on` / `finished_on` are DATEs and already the LOCAL day StoryGraph shows
--     (the ADR 0062 rule). Never passed through a zone.
--   * `matched_key` is the BookWyrm book the row matched at import time; NULL = unmatched,
--     stored and reported but not shown by the reading tools.
--   * Nothing else from the export is stored: no rating, review, mood or warning column.
CREATE TABLE "storygraph_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_ap_id" text NOT NULL,
	"book_key" text NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isbn13" text,
	"started_on" date,
	"finished_on" date,
	"range_key" text NOT NULL,
	"matched_key" text,
	"matched_book_url" text,
	"matched_by" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storygraph_reads_has_a_date" CHECK ("started_on" IS NOT NULL OR "finished_on" IS NOT NULL),
	CONSTRAINT "storygraph_reads_in_order" CHECK ("started_on" IS NULL OR "finished_on" IS NULL OR "started_on" <= "finished_on"),
	CONSTRAINT "storygraph_reads_matched_by" CHECK ("matched_by" IS NULL OR "matched_by" IN ('isbn', 'title_author'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storygraph_reads_identity_idx" ON "storygraph_reads" USING btree ("actor_ap_id","book_key","range_key");
--> statement-breakpoint
CREATE INDEX "storygraph_reads_actor_matched_idx" ON "storygraph_reads" USING btree ("actor_ap_id","matched_key");
