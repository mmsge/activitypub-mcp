-- Gigs from Gigowl (samklang.msge.no): the per-actor attendance store, and the
-- catalogue caches for the concert, its artists and its venue.
--
-- The split mirrors neodb_marks + catalog_metadata, and for the same reason
-- (ADR 0008): going to a gig is a fact about a person, and the gig itself is a
-- fact about the world. One is per (concert, actor) and multi-valued over time;
-- the other is shared by everyone who was there. Bolting them together would
-- conflate two lifecycles and break the one-row-per-concert contract the moment
-- a second person's attendance arrives.
--
-- An attendance federates as a plain `Note` whose `tag` carries a Link named
-- "Konsert" pointing at the concert's canonical URI. That URI dereferences as an
-- AS2 Event and is the join key throughout. See ADR 0037.
CREATE TABLE "gig_attendances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Normalised concert URL (hash/query/trailing slash stripped) — the join key
	-- onto gig_catalog.concert_url. The Link tag href and the samklang:concert
	-- property must collapse to the same string or the attendance never finds
	-- its gig and the unique index below stops deduping.
	"concert_url" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	-- interested | going | attended, plus the verb verbatim so a state added
	-- later is stored rather than dropped.
	"status" text,
	"status_raw" text,
	-- Which of the three sources yielded `status`: 'tag' (the explicit Oppmøte
	-- Link tag on the delivered Note), 'property' (samklang:attendanceStatus,
	-- present only when the Note was dereferenced at its own URI), or 'template'
	-- (an exact prefix match on the generated Nynorsk opening line).
	--
	-- The first two arrived with Gigowl's ADR 0026. Every attendance delivered
	-- before that carries the state nowhere but the opening sentence, which is
	-- why 'template' exists and why this column does: a caller that cares about
	-- provenance can tell a stated fact from a derived one. NULL status means
	-- none of the three matched, which is deliberately preferred over a guess.
	"status_source" text,
	-- The write-up. Free text, never parsed, normalised or translated: it is
	-- Nynorsk and user-facing, and it is the only part of a gig log that is
	-- actually writing.
	"review" text,
	"content_warning" text,
	"hashtags" jsonb,
	-- [{ url, mediaType, altText, width, height }]. Alt text is carried because
	-- the origin nags for it; dropping it here would waste that.
	"photos" jsonb,
	-- The attendance Note's own id. This is the Delete target, so the tombstone
	-- path matches on it.
	"note_ap_id" text,
	"note_url" text,
	"post_id" text,
	-- The Note's `published`. The origin stamps it with the attendance's
	-- updatedAt, so it is when the gig was LOGGED or last edited, never when it
	-- happened: a 2022 gig entered in 2026 publishes in 2026. The night itself is
	-- gig_catalog.gig_date. Sorting gigs by this column is the mistake that makes
	-- an archive import look like it all happened on a Tuesday.
	"published_at" timestamp with time zone,
	-- Change-tracking stamp; the upsert overwrites only on a strictly newer one.
	"updated_at_ap" timestamp with time zone,
	-- Set when the attendance's Note is deleted. Soft, so the history stays
	-- auditable and a recreate can revive the row.
	"deleted_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gig_attendances_concert_actor_idx" ON "gig_attendances" USING btree ("concert_url","actor_ap_id");
--> statement-breakpoint
CREATE INDEX "gig_attendances_concert_idx" ON "gig_attendances" USING btree ("concert_url");
--> statement-breakpoint
CREATE INDEX "gig_attendances_actor_idx" ON "gig_attendances" USING btree ("actor_ap_id");
--> statement-breakpoint
-- The Delete path looks a row up by the Note id it is tombstoning.
CREATE INDEX "gig_attendances_note_ap_id_idx" ON "gig_attendances" USING btree ("note_ap_id");
--> statement-breakpoint
CREATE INDEX "gig_attendances_status_idx" ON "gig_attendances" USING btree ("status");
--> statement-breakpoint

-- The shared per-concert cache. Filled by sync-gig-metadata, which dereferences
-- the concert URL as ActivityPub and merges the page's schema.org MusicEvent as a
-- fallback for the fields an origin older than Gigowl's ADR 0026 does not serve.
CREATE TABLE "gig_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concert_url" text NOT NULL,
	-- The composite title the origin renders: "Artist, Venue, City, DATE".
	"title" text,
	-- The night of the gig, and the column everything sorts and filters on.
	--
	-- Deliberately separate from `start_at`: the AS2 Event omits its startTime
	-- entirely unless the venue has an IANA zone AND the concert a start time,
	-- which most of a backfilled archive does not. A date column that is present
	-- for every gig is worth more than an instant that is present for a third of
	-- them, so both exist and this one is authoritative for ordering.
	"gig_date" date,
	"start_at" timestamp with time zone,
	-- Local wall clock in the venue's zone, as the origin stores it.
	"doors_time" text,
	-- scheduled | cancelled | postponed | completed. 'completed' has no
	-- schema.org equivalent, so a consumer reading only the HTML JSON-LD sees a
	-- finished gig as still scheduled. Only the ActivityPub representation is
	-- complete, which is why enrichment prefers it.
	"concert_status" text,
	"tour_name" text,
	"festival_name" text,
	"notes" text,
	"venue_url" text,
	-- Denormalised from the venue so "gigs in Bergen" is one predicate rather
	-- than a join. gig_venues holds the full record.
	"venue_name" text,
	"venue_city" text,
	"venue_country" text,
	-- [{ artistUrl, name, role, position }], role headliner | opener | guest.
	"lineup" jsonb,
	-- The lineup names, flat, so "every gig I saw Motorpsycho at" is an ILIKE
	-- over a jsonb array. Same trick as catalog_metadata.mark_titles.
	"artist_names" jsonb,
	-- [{ id, artist, entries: [...] }]. Empty until the origin serves setlists,
	-- which it did not before Gigowl's ADR 0026 — they existed in HTML only.
	"setlists" jsonb,
	"song_count" integer,
	"details" jsonb,
	-- { field: 'samklang-ap' | 'samklang-jsonld' } — per-field provenance, so it
	-- is visible which half of the origin a value came from.
	"source_map" jsonb,
	"raw" jsonb,
	-- Enrichment bookkeeping, matching catalog_metadata: `enriched_at` is the
	-- last SUCCESSFUL fetch and drives staleness; `fetched_at` is the last write
	-- of any kind, so ordering always has a value. A failure records the error
	-- and bumps the attempt count rather than vanishing.
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	"fetch_error" text,
	"fetch_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	-- Set when an admin hides the row. Must never be part of the enrichment
	-- upsert's values object: including it there unhides the row on every
	-- refresh, which is exactly the bug ADR 0013 records.
	"hidden_at" timestamp with time zone,
	CONSTRAINT "gig_catalog_concert_url_unique" UNIQUE("concert_url")
);
--> statement-breakpoint
CREATE INDEX "gig_catalog_gig_date_idx" ON "gig_catalog" USING btree ("gig_date");
--> statement-breakpoint
CREATE INDEX "gig_catalog_venue_idx" ON "gig_catalog" USING btree ("venue_url");
--> statement-breakpoint
CREATE INDEX "gig_catalog_city_idx" ON "gig_catalog" USING btree ("venue_city");
--> statement-breakpoint
-- Partial on purpose. Hidden rows are the rare case, and every read path filters
-- on "not hidden", which this index cannot serve anyway; what it serves is the
-- admin's "what have I hidden" list.
CREATE INDEX "gig_catalog_hidden_idx" ON "gig_catalog" USING btree ("hidden_at") WHERE "hidden_at" IS NOT NULL;
--> statement-breakpoint

-- The artist cache. Its own table rather than only the lineup blob, because an
-- artist is shared across every gig they played and their external ids are what
-- let a gig join up with the scrobble and NeoDB data already in this database.
CREATE TABLE "gig_artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_url" text NOT NULL,
	"name" text,
	"sort_name" text,
	"disambiguation" text,
	-- person | group | other. The origin serves an artist as an AS2 Person or
	-- Organization; an artist whose type it does not know stays a plain Object
	-- rather than being guessed into one of the two, and this column carries the
	-- origin's own value.
	"artist_type" text,
	"country" text,
	"mbid" text,
	"wikidata_qid" text,
	"begin_year" integer,
	"end_year" integer,
	"image_url" text,
	-- Required whenever image_url is set: Commons images carry licence terms.
	"image_attribution" text,
	"source_map" jsonb,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	"fetch_error" text,
	"fetch_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "gig_artists_artist_url_unique" UNIQUE("artist_url")
);
--> statement-breakpoint
CREATE INDEX "gig_artists_name_idx" ON "gig_artists" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "gig_artists_mbid_idx" ON "gig_artists" USING btree ("mbid");
--> statement-breakpoint

-- The venue cache. Same shape, same reasons.
CREATE TABLE "gig_venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_url" text NOT NULL,
	"name" text,
	-- Former and alternative names: venues get renamed by sponsors, and a gig
	-- remembered under the old name still has to be findable.
	"aka" jsonb,
	"city" text,
	"country" text,
	"latitude" numeric,
	"longitude" numeric,
	"capacity" integer,
	-- IANA zone. Without it the origin cannot render a start time unambiguously,
	-- which is why so many concerts have no start_at.
	"timezone" text,
	"wikidata_qid" text,
	-- The origin's "venue not announced yet" placeholder. A gig at one has a
	-- genuinely unknown venue, which is different from missing data, and should
	-- read as "venue TBA" rather than as a gap.
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"source_map" jsonb,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	"fetch_error" text,
	"fetch_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "gig_venues_venue_url_unique" UNIQUE("venue_url")
);
--> statement-breakpoint
CREATE INDEX "gig_venues_name_idx" ON "gig_venues" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "gig_venues_city_idx" ON "gig_venues" USING btree ("city");
