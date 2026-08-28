-- Thread tracking for the owner's own toots: store the SHAPE of a conversation and
-- never its words. See decision record 0057.
--
-- `replies_count` on a status counts direct children only, so a toot with four replies
-- that each spawned an argument loses to one with thirteen flat replies. The real answer
-- needs /api/v1/statuses/:id/context per root, which is far too slow to run on demand
-- across two thousand roots — hence a background walk into these two tables.
--
-- The privacy constraint is the design constraint. Stored per node: ids, the permalink,
-- the parent link, the depth, the publish time, the participant's handle, and whether
-- the node is the owner's. NOT stored, ever: reply text, content warnings, summaries,
-- attachments, alt text, media URLs, display names, avatars, bios, follower counts, or
-- anyone else's favourite and boost counts. A renderer reads the skeleton from here and
-- fetches the actual posts live from their origin when a node is opened.
--
-- **The CHECK constraints below are that promise, enforced.** "There is no content
-- column" is a fact about today's schema, not a rule — a later ALTER TABLE could add
-- one, and a later INSERT could stuff prose into `handle`. Every text column here is
-- therefore constrained to an identifier, a hostname or an https URL, none of which can
-- carry a sentence. `src/db/thread-schema.test.ts` pins the column set so that adding a
-- column fails CI rather than passing review. Two layers, because either alone is a
-- convention.

CREATE TABLE "thread_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

	-- The root toot's canonical AP id. Deliberately NOT a foreign key to objects.ap_id:
	-- engagement_snapshots and post_breakout_state make the same choice for the same
	-- reason — a delete-and-re-ingest cycle must not cascade a walk away.
	"root_ap_id" text NOT NULL,
	-- Who wrote it, so the leaderboard can be scoped without joining `objects`.
	"actor_ap_id" text NOT NULL,
	-- The origin-local id and lowercase host the context endpoint is asked about. Stored
	-- rather than re-parsed off `root_ap_id` on every tick.
	"root_status_id" text NOT NULL,
	"origin" text NOT NULL,

	-- The statistics the leaderboard ranks on. `node_count` INCLUDES the root, which is
	-- stored as a node at depth 0 so the tree is renderable from one query; every
	-- `external_*` figure excludes the owner's own nodes, so a thread made only of his
	-- own replies scores zero and never appears.
	"node_count" integer DEFAULT 0 NOT NULL,
	"external_node_count" integer DEFAULT 0 NOT NULL,
	"max_depth" integer DEFAULT 0 NOT NULL,
	"external_participant_count" integer DEFAULT 0 NOT NULL,

	-- The newest node in the tree, and the whole basis of the settled/unsettled split:
	-- the daily incremental pass re-walks a thread while this is under THREAD_SETTLED_DAYS
	-- old and skips it afterwards, so a daily job does not repeat the backfill.
	--
	-- It falls back to the ROOT's own published_at when there are no replies. Left null,
	-- a brand-new toot with no replies yet would read as settled the moment it was first
	-- walked — which is precisely the week in which its replies arrive.
	"newest_node_at" timestamp with time zone,

	-- Walk bookkeeping. A root that keeps failing must be visible as a failure rather
	-- than as an absence: a clean run that explains nothing is not observability
	-- (record 0039). A failed walk leaves the previously stored tree untouched.
	"walked_at" timestamp with time zone,
	"walk_attempts" integer DEFAULT 0 NOT NULL,
	"walk_error" text,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,

	CONSTRAINT "thread_roots_root_ap_id_shape" CHECK ("root_ap_id" ~ '^https?://[^[:space:]]+$' AND length("root_ap_id") <= 500),
	CONSTRAINT "thread_roots_actor_ap_id_shape" CHECK ("actor_ap_id" ~ '^https?://[^[:space:]]+$' AND length("actor_ap_id") <= 500),
	CONSTRAINT "thread_roots_status_id_shape" CHECK ("root_status_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "thread_roots_origin_shape" CHECK ("origin" ~ '^[a-z0-9.-]{1,253}$'),
	-- The one column that holds a message, and it holds OUR message: a fetch failure,
	-- never anything read out of a reply. Bounded so it cannot become a text field by
	-- habit.
	CONSTRAINT "thread_roots_walk_error_len" CHECK ("walk_error" IS NULL OR length("walk_error") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_roots_root_idx" ON "thread_roots" ("root_ap_id");
--> statement-breakpoint
-- The incremental pass's work queue: unsettled first, oldest walk first.
CREATE INDEX "thread_roots_newest_node_idx" ON "thread_roots" ("newest_node_at");
--> statement-breakpoint
CREATE INDEX "thread_roots_walked_idx" ON "thread_roots" ("walked_at");
--> statement-breakpoint
-- The leaderboard's default ordering, scoped per account.
CREATE INDEX "thread_roots_actor_external_idx" ON "thread_roots" ("actor_ap_id","external_node_count");
--> statement-breakpoint

-- One row per node in the tree, INCLUDING the root at depth 0.
--
-- A walk REPLACES a thread's rows inside one transaction rather than merging into them,
-- which is what makes a deleted reply disappear on the next walk with no tombstone to
-- reason about. It also means the parent link can be stored as a plain id: the whole set
-- is written together, so it is internally consistent by construction.
CREATE TABLE "thread_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_ap_id" text NOT NULL REFERENCES "thread_roots"("root_ap_id") ON DELETE CASCADE ON UPDATE CASCADE,

	"status_ap_id" text NOT NULL,
	-- The id local to `origin`, so a renderer can open the node at its own instance.
	"status_id" text NOT NULL,
	"origin" text NOT NULL,
	-- The permalink, so a node can be opened or embedded without a lookup. Null when the
	-- origin gave none rather than guessed at.
	"url" text,

	-- Null on the root. Points at another node's `status_ap_id` in the same tree; not a
	-- foreign key, because the delete-and-replace above writes the set as a whole and a
	-- self-referential FK would order the inserts for no gain.
	"parent_status_ap_id" text,
	-- Hops from the root. The root is 0.
	"depth" integer NOT NULL,
	"published_at" timestamp with time zone,

	-- The ONLY piece of data about an external participant kept anywhere, in @user@host
	-- form. No profile lookup is performed during the walk, and nothing else about a
	-- participant is stored.
	"handle" text NOT NULL,
	"is_mine" boolean NOT NULL,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,

	CONSTRAINT "thread_nodes_status_ap_id_shape" CHECK ("status_ap_id" ~ '^https?://[^[:space:]]+$' AND length("status_ap_id") <= 500),
	CONSTRAINT "thread_nodes_parent_shape" CHECK ("parent_status_ap_id" IS NULL OR ("parent_status_ap_id" ~ '^https?://[^[:space:]]+$' AND length("parent_status_ap_id") <= 500)),
	CONSTRAINT "thread_nodes_url_shape" CHECK ("url" IS NULL OR ("url" ~ '^https?://[^[:space:]]+$' AND length("url") <= 500)),
	CONSTRAINT "thread_nodes_status_id_shape" CHECK ("status_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "thread_nodes_origin_shape" CHECK ("origin" ~ '^[a-z0-9.-]{1,253}$'),
	-- @user@host and nothing else. A display name, a bio or a line of reply text all
	-- fail this, which is the point: there is no text column in this table that prose
	-- can be smuggled through.
	CONSTRAINT "thread_nodes_handle_shape" CHECK ("handle" ~ '^@[^@[:space:]]{1,64}@[a-z0-9.-]{1,253}$'),
	CONSTRAINT "thread_nodes_depth_range" CHECK ("depth" >= 0 AND "depth" <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_nodes_root_status_idx" ON "thread_nodes" ("root_ap_id","status_ap_id");
--> statement-breakpoint
CREATE INDEX "thread_nodes_root_depth_idx" ON "thread_nodes" ("root_ap_id","depth");
