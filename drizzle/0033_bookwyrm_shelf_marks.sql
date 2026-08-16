-- BookWyrm shelf membership, per actor.
--
-- The split mirrors neodb_marks + catalog_metadata (ADR 0008) and gig_attendances
-- + gig_catalog (ADR 0037), for the same reason: book_metadata is the SHARED
-- per-edition bibliographic cache — one row per book, no owner — while which shelf
-- a book sits on belongs to one reader.
--
-- There is a second reason specific to books. sync-book-metadata's upsert does
-- `set: values`, so any column added to that object is overwritten on every
-- refresh. That is precisely the trap ADR 0013 records for `hidden_at`, and a
-- `shelf` column on book_metadata would walk into it again: a re-enrichment would
-- blank the shelf and framfor would lose the book out of its catalogue.
--
-- BookWyrm's four reading shelves are MUTUALLY EXCLUSIVE. Verified against
-- @mvrkws@bookwyrm.social on 2026-08-16: read 408, to-read 30, stopped-reading 10,
-- reading 3 — union 451, pairwise overlap 0 on all six pairs. So shelf is a scalar
-- per (actor, book) and the key below is a unique pair, not an (actor, book, shelf)
-- triple. If a future BookWyrm ever puts one book on two shelves the upsert will
-- flip-flop rather than duplicate, which is the safe way to be wrong.
--
-- Why the table exists at all, rather than a widening of the derived collapse in
-- lib/bookwyrm-reading.ts: a stop DOES federate, as a GeneratedNote reading
-- "… stopped reading <book>" — but only 3 of the 10 stopped books have one in the
-- archive. Posts record the events that were witnessed; the shelf records the
-- current truth, and only the shelf is complete.
CREATE TABLE "bookwyrm_shelf_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- The shelf owner: a full actor AP id, resolved from BOOKWYRM_ACTORS the same
	-- way sync-reading-history resolves it. Never a handle.
	"actor_ap_id" text NOT NULL,
	-- The Edition AP id — the join key onto book_metadata.book_url. A shelf
	-- collection's orderedItems are bare Edition objects whose `id` IS this URL, so
	-- the two sides need no normalisation to line up.
	"book_url" text NOT NULL,
	-- read | reading | to-read | stopped-reading, stored as BookWyrm's own URL slug.
	-- Verbatim rather than mapped, so a shelf added later lands in the table instead
	-- of being coerced into one of these four or dropped.
	"shelf" text NOT NULL,
	-- BookWyrm's `shelvedDate`, when it sends one. As of 2026-08-16 it sends null for
	-- every item on every one of the four shelves — checked, not assumed — so nothing
	-- may be built on this column. `first_seen_at` is the only date this table can
	-- promise, and it dates OUR first sighting, not the day he shelved the book.
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shelved_date" timestamp with time zone,
	-- Set when a pull that is VERIFIED COMPLETE no longer finds the book on any of
	-- the actor's shelves. Soft, like neodb_marks.deleted_at and framfor's
	-- missing_since — and for the reason framfor's own missing-sweep guard exists: a
	-- truncated pull and an emptied shelf look identical from the database's side.
	--
	-- Here we can do better than framfor's 80% heuristic, because BookWyrm hands us
	-- the exact expected count: the sweep runs only when every one of the four
	-- shelves fetched without a single failed page AND the item count equals the
	-- Shelf collection's own `totalItems`. Anything short of that writes upserts and
	-- no removals. Using a percentage where an exact number is published would be
	-- choosing to be approximately right on purpose.
	--
	-- Cleared by the next upsert, so a book that comes back comes back whole.
	"removed_at" timestamp with time zone,
	CONSTRAINT "bookwyrm_shelf_marks_actor_book_idx" UNIQUE("actor_ap_id","book_url")
);
--> statement-breakpoint
CREATE INDEX "bookwyrm_shelf_marks_book_url_idx" ON "bookwyrm_shelf_marks" USING btree ("book_url");
--> statement-breakpoint
CREATE INDEX "bookwyrm_shelf_marks_actor_idx" ON "bookwyrm_shelf_marks" USING btree ("actor_ap_id");
--> statement-breakpoint
-- The serving predicate is "a live row on shelf X", so the partial index carries
-- exactly that and not the tombstones. The same shape, and the same argument, as
-- framfor's items_arena_eligible.
CREATE INDEX "bookwyrm_shelf_marks_live_idx" ON "bookwyrm_shelf_marks" USING btree ("shelf","book_url") WHERE "removed_at" IS NULL;
