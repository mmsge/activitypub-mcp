CREATE TABLE "neodb_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_url" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	"item_type" text,
	"category" text,
	"status" text,
	"status_raw" text,
	"title" text,
	"cover_url" text,
	"mark_ap_id" text,
	"mark_url" text,
	"post_id" text,
	"published_at" timestamp with time zone,
	"updated_at_ap" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "neodb_marks_item_actor_idx" ON "neodb_marks" USING btree ("item_url","actor_ap_id");--> statement-breakpoint
CREATE INDEX "neodb_marks_item_url_idx" ON "neodb_marks" USING btree ("item_url");--> statement-breakpoint
CREATE INDEX "neodb_marks_actor_idx" ON "neodb_marks" USING btree ("actor_ap_id");--> statement-breakpoint
CREATE INDEX "neodb_marks_mark_ap_id_idx" ON "neodb_marks" USING btree ("mark_ap_id");--> statement-breakpoint
CREATE INDEX "neodb_marks_status_idx" ON "neodb_marks" USING btree ("status");