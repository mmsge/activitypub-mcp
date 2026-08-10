-- LinkedIn: two sources that never meet upstream, joined here on the post id.
--
-- Post *content* comes from LinkedIn's DMA Member Snapshot API, polled weekly.
-- Post *performance* comes from an .xlsx Markus exports by hand once a month.
-- The manual half is not a stopgap to be designed away: impressions and
-- engagement rate live behind `r_member_postAnalytics`, inside the partner-gated
-- Community Management product, which he has no route to. The DMA product he can
-- reach carries what he wrote and nothing about how it did.
--
--   linkedin_posts          one row per post, upserted by the poller. The snapshot
--                           is historical and complete on every call, so the poller
--                           is idempotent by construction and re-sees every post
--                           every week.
--
--   linkedin_post_metrics   APPEND-ONLY, one row per post per export.
--
--   source_sync_state       per-source ingest health, so a dead token is visible
--                           without reading logs.
--
-- Three things here are deliberate and will look like mistakes otherwise.
--
-- **`post_key`, not the URL, is the join.** The brief for this work said the post
-- URL is the join key and no URN mapping is needed. No mapping *call* is needed —
-- but the two sources do not emit the same string for the same post. The API emits
-- `/feed/update/urn:li:activity:<id>`; the export emits
-- `/posts/<slug>-ugcPost-<id>-<hash>`. Both carry the same numeric id, so that id
-- is extracted on ingest and each source's URL is kept verbatim beside it. Joining
-- on the raw URL would match nothing, and would do so silently.
--
-- **Metrics are append-only and never updated.** LinkedIn's exported impressions
-- are a windowed accumulation, not a lifetime total, so two exports of one post are
-- two different observations rather than an old and a corrected value. Overwriting
-- would discard the difference between them — which is the reach-decay series, and
-- the most useful thing in the file. The unique index on (post_key, export_date) is
-- what makes re-importing the same file a no-op instead of a duplicate.
--
-- **`linkedin_post_metrics` has no foreign key to `linkedin_posts`.** A metric row
-- can arrive for a post the poller has not ingested yet, and a foreign key would
-- reject exactly those rows. `posted_on` is therefore carried on the metric row as
-- well, so such a post still has a weekday before the poller backfills its text.
--
-- See ADR 0033.
CREATE TABLE "linkedin_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- The numeric activity/ugcPost id, extracted from whichever URL form the
	-- source used. The join key between the poller and the .xlsx import.
	"post_key" text NOT NULL,
	-- Exactly as the poller received it; the export's spelling lives on the metric row.
	"post_url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"commentary" text,
	-- LinkedIn's own visibility string (PUBLIC, ANYONE, CONNECTIONS, …). Gates the
	-- REST surface, which serves publicly-visible posts only and fails closed on a
	-- value it cannot read. See ADR 0026.
	"visibility" text,
	-- The link attached to the post, if any — not the post's own permalink.
	"shared_url" text,
	"is_reshare" boolean DEFAULT false NOT NULL,
	-- The untouched snapshotData entry. LinkedIn documents the key names for exactly
	-- one snapshot domain and this is not it, and the endpoint is pinned to version
	-- 202312 forever, so no version bump would ever announce a rename. Keeping the
	-- original makes a rename a re-parse over stored rows rather than a re-fetch
	-- behind a token that may since have expired.
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_post_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_key" text NOT NULL,
	-- The URL as the .xlsx spelled it — usually a different form to the poller's.
	"post_url" text NOT NULL,
	-- Derived from the export's own daily series (its last day), never typed by the
	-- uploader: a form field would let one file import twice under two keys and
	-- defeat the unique index below.
	"export_date" date NOT NULL,
	"window_start" date,
	"window_end" date,
	-- Publish date from the sheet. Date-only: the export carries no publish time,
	-- which is why weekday analysis is possible and hour-of-day analysis is not.
	"posted_on" date,
	"impressions" integer,
	-- Null when the post appeared only in the impressions block. The export's
	-- engagement block covers ~14 posts against the impressions block's ~50, so a
	-- lower-reach post legitimately has one and not the other. Never a guess.
	"engagements" integer,
	"raw" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_sync_state" (
	-- Source slug ('linkedin'). Keyed by source rather than being a LinkedIn
	-- singleton so the other pollers can adopt it later without a migration; only
	-- 'linkedin' writes to it today.
	"source" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	-- The last run that actually completed. Deliberately untouched by a failure —
	-- it is what separates "stale" from "never worked".
	"last_success_at" timestamp with time zone,
	"last_error" text,
	-- HTTP status of the last failure. 401/403 is what makes a token "expired"
	-- rather than the upstream merely having a bad day.
	"last_status" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"items_last_run" integer,
	-- Latch for the failure push, so a weekly poller alerts once per outage and
	-- does not train its reader to ignore it. Cleared by the next success.
	"notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_posts_key_idx" ON "linkedin_posts" USING btree ("post_key");--> statement-breakpoint
CREATE INDEX "linkedin_posts_posted_idx" ON "linkedin_posts" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "linkedin_posts_visibility_idx" ON "linkedin_posts" USING btree ("visibility");--> statement-breakpoint
-- Re-importing the same export must be a no-op; this is that guarantee.
CREATE UNIQUE INDEX "linkedin_post_metrics_dedupe_idx" ON "linkedin_post_metrics" USING btree ("post_key","export_date");--> statement-breakpoint
CREATE INDEX "linkedin_post_metrics_posted_idx" ON "linkedin_post_metrics" USING btree ("posted_on");
