CREATE TABLE "book_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_url" text NOT NULL,
	"work_url" text,
	"title" text,
	"pages" integer,
	"physical_format" text,
	"isbn13" text,
	"pub_year" integer,
	"language" text,
	"page_source" text,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_metadata_book_url_unique" UNIQUE("book_url")
);
--> statement-breakpoint
CREATE INDEX "book_metadata_book_url_idx" ON "book_metadata" USING btree ("book_url");--> statement-breakpoint
CREATE INDEX "book_metadata_work_url_idx" ON "book_metadata" USING btree ("work_url");--> statement-breakpoint
CREATE INDEX "book_metadata_format_idx" ON "book_metadata" USING btree ("physical_format");