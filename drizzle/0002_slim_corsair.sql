CREATE TABLE "linkedin_auth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_urn" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_enc" text,
	"refresh_token_expires_at" timestamp with time zone,
	"scopes" text DEFAULT '' NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_auth_member_urn_unique" UNIQUE("member_urn")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "domain" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "public_key_pem" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "inbox_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "source" text DEFAULT 'activitypub' NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "profile_url" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "source" text DEFAULT 'activitypub' NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "source_external_id" text;--> statement-breakpoint
CREATE INDEX "media_hash_idx" ON "media" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "actors_source_idx" ON "actors" USING btree ("source");--> statement-breakpoint
CREATE INDEX "objects_source_idx" ON "objects" USING btree ("source","actor_ap_id","published_at");