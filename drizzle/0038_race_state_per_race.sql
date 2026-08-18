-- Key the race watcher's state on a race id rather than on an artist pairing.
--
-- The pairing key could express exactly one thing: a race between two artists. It had
-- no way to name a race whose sides are albums ("The Good Witch" vs "Florescence" —
-- one artist, two records), and no way to hold a second race at all, because the whole
-- race lived in RACE_LEADER_ARTIST / RACE_CHALLENGER_ARTIST. Races now live in
-- races.json and this table is keyed on their ids. See decision record 0052.
--
-- Everything else about the row survives on purpose. The brief for this work proposed a
-- fresh four-column table; every column it dropped is load-bearing:
--
--   leader_plays / challenger_plays  the "nothing scrobbled since we last looked"
--                                    short-circuit. Without it every tick re-decides.
--   last_announced_gap               per-play dedupe inside the countdown band, so a
--                                    poll with no new play stays quiet.
--   last_nowplaying_key / _at        the same for the live now-playing alert.
--   endgame_armed_at                 a LATCH WITH A TIMESTAMP, not a boolean level.
--                                    Record 0022 exists to say so: a boolean would let
--                                    the leader scrobbling twice un-arm a race that has
--                                    demonstrably reached its endgame.
ALTER TABLE "scrobble_race_state" RENAME TO "race_state";
--> statement-breakpoint
ALTER TABLE "race_state" ADD COLUMN "race_id" text;
--> statement-breakpoint
UPDATE "race_state" SET "race_id" = 'maisie-vs-taylor'
  WHERE "leader_artist" = 'Taylor Swift' AND "challenger_artist" = 'Maisie Peters';
--> statement-breakpoint
-- The race is run: Maisie Peters passed Taylor Swift on 2026-08-13. Stamp the result if
-- the live row somehow never recorded it, so the archived race keeps its answer.
UPDATE "race_state" SET "overtaken_at" = '2026-08-13T10:55:40Z'
  WHERE "race_id" = 'maisie-vs-taylor' AND "overtaken_at" IS NULL;
--> statement-breakpoint
-- Any other pairing keeps its history under a synthetic id rather than being deleted.
-- A row here is a record of which milestones were already announced to somebody's
-- phone; losing one would replay them.
UPDATE "race_state"
  SET "race_id" = 'legacy:' || "leader_artist" || ' vs ' || "challenger_artist"
  WHERE "race_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "race_state" ALTER COLUMN "race_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "scrobble_race_pair_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "race_state_race_idx" ON "race_state" USING btree ("race_id");
--> statement-breakpoint
-- Kept for one release rather than dropped: nothing writes them any more, but they are
-- the only record of which pairing a migrated row came from if races.json turns out to
-- disagree with what was actually being watched.
ALTER TABLE "race_state" ALTER COLUMN "leader_artist" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "race_state" ALTER COLUMN "challenger_artist" DROP NOT NULL;
