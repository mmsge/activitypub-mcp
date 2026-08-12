-- trip_posts.object_ap_id follows its object when the object is RENAMED, not just
-- when it is deleted.
--
-- The parent key here is a remote identifier, and remote identifiers move. Gigowl
-- changed address and renamed every one of its Notes with it (ADR 0038), which is
-- when this surfaced: `ON DELETE cascade ON UPDATE no action` refused the parent
-- update outright —
--
--   update or delete on table "objects" violates foreign key constraint
--   "trip_posts_object_ap_id_objects_ap_id_fk" on table "trip_posts"
--
-- — because attendance Notes published during an import happened to fall inside a
-- train trip's window and had been matched to it. The rebase could then not touch
-- `objects` at all.
--
-- Cascading on update is also what the row MEANS. A trip↔post link is derived from
-- a time window (ADR 0023): it is about that post, whatever the post is called this
-- week. `ON DELETE cascade` is unchanged — a post that is gone has no trip.
ALTER TABLE "trip_posts" DROP CONSTRAINT "trip_posts_object_ap_id_objects_ap_id_fk";--> statement-breakpoint
ALTER TABLE "trip_posts" ADD CONSTRAINT "trip_posts_object_ap_id_objects_ap_id_fk" FOREIGN KEY ("object_ap_id") REFERENCES "public"."objects"("ap_id") ON DELETE cascade ON UPDATE cascade;
