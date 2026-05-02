CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	"object_ap_id" text,
	"object_type" text,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processing_error" text,
	CONSTRAINT "activities_ap_id_unique" UNIQUE("ap_id")
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"request_headers" jsonb,
	"request_body" text,
	"response_status" integer,
	"response_body" text,
	"signature_valid" boolean,
	"error" text,
	"actor_ap_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_id" text NOT NULL,
	"handle" text,
	"username" text,
	"domain" text NOT NULL,
	"display_name" text,
	"summary" text,
	"icon_url" text,
	"public_key_pem" text NOT NULL,
	"inbox_url" text NOT NULL,
	"shared_inbox_url" text,
	"followers_url" text,
	"following_url" text,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_ap_id_unique" UNIQUE("ap_id")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "bookwyrm_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_ap_id" text NOT NULL,
	"bw_type" text NOT NULL,
	"book_title" text,
	"book_author" text,
	"book_isbn" text,
	"rating" numeric(3, 1),
	"reading_status" text,
	"start_date" date,
	"finish_date" date,
	"progress" integer,
	"progress_mode" text,
	"review_content" text,
	"raw" jsonb NOT NULL,
	CONSTRAINT "bookwyrm_objects_object_ap_id_unique" UNIQUE("object_ap_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_ap_id" text NOT NULL,
	"follow_activity_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"followed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	CONSTRAINT "follows_actor_ap_id_unique" UNIQUE("actor_ap_id")
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	"content" text,
	"content_text" text,
	"summary" text,
	"url" text,
	"in_reply_to" text,
	"published_at" timestamp with time zone,
	"updated_at_ap" timestamp with time zone,
	"attachments" jsonb,
	"tags" jsonb,
	"sensitive" boolean DEFAULT false,
	"language" text,
	"raw" jsonb NOT NULL,
	"search_vector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "objects_ap_id_unique" UNIQUE("ap_id")
);
--> statement-breakpoint
CREATE TABLE "server_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activities_actor_idx" ON "activities" USING btree ("actor_ap_id");--> statement-breakpoint
CREATE INDEX "activities_type_idx" ON "activities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "activities_received_idx" ON "activities" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_log_actor_idx" ON "activity_log" USING btree ("actor_ap_id");--> statement-breakpoint
CREATE INDEX "activity_log_direction_idx" ON "activity_log" USING btree ("direction");--> statement-breakpoint
CREATE INDEX "actors_domain_idx" ON "actors" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "bookwyrm_reading_status_idx" ON "bookwyrm_objects" USING btree ("reading_status");--> statement-breakpoint
CREATE INDEX "bookwyrm_actor_idx" ON "bookwyrm_objects" USING btree ("object_ap_id");--> statement-breakpoint
CREATE INDEX "delivery_queue_next_attempt_idx" ON "delivery_queue" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "objects_actor_idx" ON "objects" USING btree ("actor_ap_id");--> statement-breakpoint
CREATE INDEX "objects_type_idx" ON "objects" USING btree ("type");--> statement-breakpoint
CREATE INDEX "objects_published_idx" ON "objects" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "objects_actor_published_idx" ON "objects" USING btree ("actor_ap_id","published_at");