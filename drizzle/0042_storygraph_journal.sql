-- StoryGraph reading journal, pulled from sidetal (mmsge/storygraph-leser).
--
-- sidetal scrapes Markus' StoryGraph reading journal every night into its own SQLite
-- and serves it as bearer-token JSON on the same box. This service pulls it on a timer
-- (sync-storygraph) and answers "how many pages, when, of what" from Postgres, next to
-- the scrobbles, trips and gigs it already holds. See ADR 0062, and sidetal's ADR 0002
-- for why the direction is pull rather than push.
--
-- Rules these columns encode, which the tools depend on:
--
--   * `entry_date` is a DATE and it is already the LOCAL calendar day StoryGraph shows.
--     It is never derived from an instant and never passed through AT TIME ZONE. That is
--     the opposite of the scrobble timeline (ADR 0059), where the stored value IS an
--     instant and the local day has to be computed; here the conversion has already been
--     done by the only party that knew the zone, and doing it again would move evening
--     entries onto the wrong day.
--   * `pages_read` is StoryGraph's own per-update delta. A day's pages are SUM(pages_read)
--     over that day's live entries. It is never recomputed from `pages_total`, which is a
--     position, resets on an edition change and would turn one correction into a spike.
--   * Entries with a null date or a null pages_read (a "started" marker, a percent-only
--     update) contribute nothing to page totals, but are stored and served all the same.
--   * `deleted_at` is propagated, not acted on: sidetal's `since_updated` feed returns
--     soft-deleted rows so that a deletion reaches us, and every page figure filters
--     them out. Nothing is hard-deleted here.
--   * `source_updated_at` is sidetal's `updated_at` and is the sync cursor: the job asks
--     for everything changed since max(source_updated_at), so the cursor is derived from
--     the data itself and needs no state row of its own.
--
-- Health of the pull is recorded in `source_sync_state` under source 'storygraph', the
-- same row shape LinkedIn uses (ADR 0033/0039), so a refused token is a latched ntfy push
-- rather than a silent stop.
CREATE TABLE "storygraph_journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"book_title" text,
	"entry_date" date,
	"kind" text NOT NULL,
	"pages_read" integer,
	"pages_total" integer,
	"book_pages" integer,
	"percent" double precision,
	"source_updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storygraph_books" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pages" integer,
	"cover_url" text,
	"raw" jsonb NOT NULL,
	"updated_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storygraph_journal_entries_date_idx" ON "storygraph_journal_entries" USING btree ("entry_date");
--> statement-breakpoint
CREATE INDEX "storygraph_journal_entries_book_idx" ON "storygraph_journal_entries" USING btree ("book_id");
--> statement-breakpoint
CREATE INDEX "storygraph_journal_entries_source_updated_idx" ON "storygraph_journal_entries" USING btree ("source_updated_at");
