CREATE TABLE "local_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_text" text NOT NULL,
	"digest" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "local_notes_published_idx" ON "local_notes" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "local_notes_kind_idx" ON "local_notes" USING btree ("kind");