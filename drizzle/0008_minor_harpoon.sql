CREATE TABLE "engagement_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_ap_id" text NOT NULL,
	"status_id" text NOT NULL,
	"origin" text NOT NULL,
	"favourites" integer NOT NULL,
	"reblogs" integer NOT NULL,
	"replies" integer NOT NULL,
	"quotes" integer,
	"source" text NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engagement_snapshots_status_sampled_idx" ON "engagement_snapshots" USING btree ("status_ap_id","sampled_at");--> statement-breakpoint
CREATE INDEX "engagement_snapshots_origin_status_idx" ON "engagement_snapshots" USING btree ("origin","status_id");