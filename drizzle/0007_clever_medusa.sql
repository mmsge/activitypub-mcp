CREATE TABLE "garden_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_path" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"etag" text,
	"last_modified" text,
	"fetched_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"fetch_error" text,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garden_notes_source_path_unique" UNIQUE("source_path")
);
--> statement-breakpoint
CREATE INDEX "garden_notes_path_idx" ON "garden_notes" USING btree ("path");