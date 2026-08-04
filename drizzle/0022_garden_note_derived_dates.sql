-- Recover a date for the garden notes that never carried one.
--
-- 0021 persisted each note's own `dato`/`modified`/`anskaffet` frontmatter. That
-- covers 102 of the 384 published notes; the other 282 have no date field of any
-- kind — not in frontmatter, not as an mtime on the Obsidian Publish cache entry.
-- Ordering the stream by event date therefore left three quarters of the garden
-- out of meg.msge.no entirely.
--
-- 158 of those 282 do carry a `bookwyrm` frontmatter field: the BookWyrm Edition
-- URL of the book being reviewed. That is already the join key this codebase uses
-- (`book_metadata.book_url`, see sync-book-metadata.ts), and the archive already
-- holds Markus' own dated reading events for those editions. So the date is
-- recoverable — not invented.
--
--   book_url      the `bookwyrm` frontmatter value, stored so the join is a column
--                 rather than a re-parse of the cache document on every run
--   derived_date  the date recovered from that book's reading events, written by
--                 jobs/derive-garden-dates.ts
--
-- Two columns rather than writing into `note_date`, deliberately. `note_date` is
-- what the note says about itself; `derived_date` is what we worked out. Merging
-- them would make the provenance unrecoverable, and the page states which one it
-- is showing.
ALTER TABLE "garden_notes" ADD COLUMN "book_url" text;--> statement-breakpoint
ALTER TABLE "garden_notes" ADD COLUMN "derived_date" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "garden_notes_book_url_idx" ON "garden_notes" USING btree ("book_url");--> statement-breakpoint
CREATE INDEX "garden_notes_derived_date_idx" ON "garden_notes" USING btree ("derived_date");
