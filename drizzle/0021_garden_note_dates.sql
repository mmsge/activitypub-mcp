-- Persist each garden note's own date and tags.
--
-- The Tankehav notes carry a `dato`/`modified`/`anskaffet` frontmatter field, but until
-- now it lived only in the live Obsidian Publish cache document that fetchGardenPages
-- reads — `garden_notes` stored content and fetch bookkeeping and nothing about when
-- the note was written. The public stream orders every entry by when it happened, and
-- without this a note could only be placed by `created_at`, i.e. when the crawler first
-- happened to see it.
--
-- Nullable and text, not `date`: plenty of notes carry no date at all, and the ones that
-- do are hand-written frontmatter of varying precision ("2024", "2024-03", "2024-03-11").
-- Parsing is the stream's job, and a value we cannot parse must not block the sync.
ALTER TABLE "garden_notes" ADD COLUMN "note_date" text;--> statement-breakpoint
ALTER TABLE "garden_notes" ADD COLUMN "note_tags" jsonb;--> statement-breakpoint
CREATE INDEX "garden_notes_note_date_idx" ON "garden_notes" USING btree ("note_date");
