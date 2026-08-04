-- Derive each archived post's origin visibility from its ActivityStreams addressing.
--
-- Mirrors classifyVisibility() in src/stream/visibility.ts — change one and you must
-- change the other. See ADR 0017 for why this is a generated column rather than a
-- plain column filled on ingest: there are five ingest entry points (Create, Announce,
-- Update, two outbox crawls, the archive import) and they all rewrite `raw` through one
-- upsert. A generated column recomputes on every one of them, including edits, so it
-- cannot drift. A plain column would need each path to remember — and forgetting is
-- silent, and the failure mode is publishing a private post.
--
-- `@>` against a jsonb scalar is equality for a scalar field and membership for an
-- array field, so one expression covers both "to": "…#Public" and "to": ["…#Public"].
-- Both `@>` and `?` are IMMUTABLE, which a generated column requires.
--
-- Fail closed: only an explicit Public marker in `to` yields 'public'. A row with no
-- addressing at all is 'unknown', never 'public'.
ALTER TABLE "objects" ADD COLUMN "visibility" text
	GENERATED ALWAYS AS (
		CASE
			WHEN "raw"->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb
				OR "raw"->'to' @> '"as:Public"'::jsonb
				OR "raw"->'to' @> '"Public"'::jsonb
				THEN 'public'
			WHEN "raw"->'cc' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb
				OR "raw"->'cc' @> '"as:Public"'::jsonb
				OR "raw"->'cc' @> '"Public"'::jsonb
				THEN 'unlisted'
			WHEN "raw" ? 'to' OR "raw" ? 'cc'
				THEN 'private'
			ELSE 'unknown'
		END
	) STORED;--> statement-breakpoint
CREATE INDEX "objects_visibility_idx" ON "objects" USING btree ("visibility");--> statement-breakpoint
-- The exact shape the public stream pages on: one actor's publishable, non-reply,
-- undeleted posts, newest first.
CREATE INDEX "objects_public_stream_idx" ON "objects" USING btree ("actor_ap_id","published_at" DESC)
	WHERE "visibility" = 'public' AND "deleted_at" IS NULL AND "in_reply_to" IS NULL;
