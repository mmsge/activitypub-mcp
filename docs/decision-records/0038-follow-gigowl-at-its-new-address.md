# 0038 — Follow Gigowl at its new address, and move the archive with it rather than beside it

**Status:** Accepted
**Date:** 2026-08-12
**Topics:** samklang, gigowl, activitypub, federation, gigs, migration, identifiers
**Contributors:** Markus (asked: replace the old Samklang follow with the new gigowl.social account) + Claude (found that a follow swap alone would fork the archive, and designed the rebase)

## Context

Gigowl moved. Its domain changed from `samklang.msge.no` to `gigowl.social`, and in the
same window its whole URI space moved from Nynorsk to UK English — its ADR 0029 and 0030.
Every identifier this server keys the gig store on changed with it:

| before | after |
|--------|-------|
| `https://samklang.msge.no/brukar/markus` | `https://gigowl.social/user/markus` |
| `…/konsert/<ULID>` | `…/gig/<ULID>` |
| `…/oppmote/<ULID>` | `…/attendance/<ULID>` |
| `…/stad/<ULID>` | `…/venue/<ULID>` |
| `…/setliste/<ULID>` | `…/setlist/<ULID>` |

The ULIDs did not change: this is the same 29 attendances, the same concerts, wearing new
names. The old address 301s every one of these paths to its replacement, so nothing is
unreachable — and that is precisely what makes the trap quiet. **A store does not follow a
redirect.** `gig_attendances` is unique on (`concert_url`, `actor_ap_id`) and `gig_catalog`
is keyed on `concert_url`; left alone, the first attendance re-delivered from the new
address would open a second row beside the one carrying the write-up, the photos and the
setlist, and `get_gig_stats` would report 58 gigs at 46 venues. The origin's own ADR 0030
says it outright: a 301 does not rescue federation.

Two things did **not** move, and both matter:

- **The JSON-LD vocabulary `https://samklang.msge.no/ns#`.** It is a vocabulary identifier
  shared by every instance of the software, not an address on one of them, and the origin
  froze it deliberately. The RSVP status tags point at it, so moving it here would make
  every attendance state unreadable.
- **The NodeInfo software name, still `samklang`.** So the `samklang` platform slug in
  `STREAM_SOURCES` and `src/stream/sources.ts` stays exactly as it is; only the handle
  changes, to `@markus@gigowl.social|samklang`.

## Decision

**Rebase, in two halves: on the way in, and once over what is already stored.**

### 1. `canonicalGigUri` — every Gigowl URI is moved as it is read

`src/lib/gig-attendance.ts` carries a segment map — a trimmed mirror of the origin's own
`LEGACY_SEGMENTS` — and rewrites `samklang.msge.no` identifiers to their `gigowl.social`
form at the four chokepoints the store is keyed on: the normalised catalogue URL (concert,
venue, artist, setlist), the Note's id and permalink, the attending actor, and photo URLs.
`tombstoneGigAttendance` and `get_gig_details` run the same function, so a `Delete` or a
pasted URL naming the old address still resolves.

Three properties, each load-bearing:

- **A URL whose first path segment is not in the map is returned untouched.** `ns` is
  deliberately absent from the map, which is what freezes the vocabulary — not a special
  case somewhere that a later cleanup could drop.
- **It is idempotent**, because no English target is also a Nynorsk source (the origin
  asserts this in its own tests). A current URI has no legacy segments and passes through.
- **The match requires the origin *and* a `/`**, so `https://samklang.msge.no.evil.example/`
  is not the origin.

Doing this on read rather than only in the data rebase is what makes the rebase safe to be
partial: `objects.raw` is kept **verbatim as delivered**, so the local-first backfill
replays Nynorsk payloads for as long as the archive exists, and every replay has to land on
the rebased row rather than beside it.

### 2. `npm run rebase-gig-origin` — the stored rows, once

A maintenance script (`src/jobs/rebase-gig-origin.ts`), **not** a Drizzle migration, for the
reason the origin gives for the same decision on its own side: this is a one-off data
operation for one deployment that changed address, not a schema change every database
needs, and a migration with one origin's domain baked into it would run on every fresh
database and mean nothing there. `DRY_RUN=1` counts without writing; a second run is a
no-op; it closes by counting what still names the old origin and says so if anything does.

It rewrites the identifier columns of `gig_attendances`, `gig_catalog`, `gig_artists`,
`gig_venues` — including the URIs inside `lineup`, `setlists`, `details` and `photos` — and
the `objects` and `activities` rows for the attendance Notes themselves. **The objects rows
are not optional:** the stream's gigs lane joins `objects.ap_id = gig_attendances.note_ap_id`,
so the two move together or every gig disappears from the public page.

It leaves alone, on purpose:

- **`raw` and `tags`, everywhere.** Provenance that has been edited is not provenance, and
  the read path makes editing it unnecessary.
- **The `actors` row for the old account.** It is a truthful record of an account that
  existed at that address. The new one arrives when the new follow resolves.

### 3. The follow is dropped, not rewritten

`FOLLOW_ACTORS` names `@markus@gigowl.social`, and the script **deletes** the `follows` row
for the old address rather than pointing it at the new actor. Rewriting it would claim an
accepted follow of an actor that has never seen a `Follow` from us: the new server holds no
follower record, would deliver nothing, and our own table would say "accepted" forever —
the confidently-wrong-and-silent failure this repo keeps running into. Dropping it lets
`syncFollows` send a real Follow and get a real Accept.

No `Undo` is sent to the old address. There is no server there any more to receive one,
only a redirect to the new one, which would be asked to undo a follow it never had.

### 4. The prose bridge learns English

The origin's generated opening line moved to UK English with everything else (its ADR
0032), so `STATUS_PREFIXES` now holds six prefixes for three states: `I was at ` /
`I am going to ` / `I would like to see ` alongside the Nynorsk originals. Both sets stay
permanently — a delivered post is an immutable copy on someone else's server, so the 29
Nynorsk ones are still exactly as they were written, and `status_source: 'template'` is
still all they carry. The rule from record 0037 is unchanged: an opening the parser does
not recognise yields `null`, never a guess.

## Deploy order

1. `FOLLOW_ACTORS` and `STREAM_SOURCES` in `/srv/bot/.env`: `@markus@samklang.msge.no` →
   `@markus@gigowl.social` (the `|samklang` platform slug stays).
2. `make deploy`. `syncFollows` sends the Follow to the new actor.
3. `docker compose exec app npm run db:migrate` — `make deploy` does not run migrations, and
   the rebase cannot touch `objects` without migration 0031 (see the postscript).
4. `docker compose exec app npm run rebase-gig-origin` (`DRY_RUN=1` first to see the counts).

Either order works — the read path canonicalises regardless — but the stream's gigs lane is
empty in the window between the handle changing and the rebase running, because the stored
attendances are still attributed to the old actor id.

## Consequences

- One gig, one row, whichever address it arrives from. The archive stays whole across a move
  that neither side of the federation protocol has a mechanism for.
- Anything that stored a Gigowl URL outside the tables listed above — an `engagement_snapshots`
  row for an attendance Note, say — still names the old address. Those are observations
  keyed by identifier rather than the identifier itself; they degrade to "a post we have not
  sampled before", which is the correct outcome for a post that has genuinely moved.
- If the origin ever moves again, `canonicalGigUri` is the one place that needs to know, and
  the script rebases from the map without further edits.

## Postscript — the foreign key that said no, and the half-moved archive

The first production run failed partway through, and the two things it taught are worth more
than the ten minutes they cost.

**`trip_posts` refused the `objects` update.** `trip_posts.object_ap_id` referenced
`objects.ap_id` with `ON DELETE cascade ON UPDATE no action`, so renaming a parent row was
simply forbidden:

```
update or delete on table "objects" violates foreign key constraint
"trip_posts_object_ap_id_objects_ap_id_fk" on table "trip_posts"
```

There were rows to violate because the whole 29-attendance archive was imported in one
afternoon and stamped with that afternoon (the `published` trap this record's predecessor
already documents), and Markus was on a train for part of it — so the trip matcher, which
joins on a time window and nothing else, bound gig Notes to a train journey. A quirk in
isolation; a blocker here.

Migration 0031 makes that constraint `ON UPDATE cascade`, which is what the row already
meant: the parent key is a **remote** identifier and remote identifiers move, while the link
itself is derived from a time window (ADR 0023) and is about that post whatever it is now
called. `ON DELETE cascade` is unchanged.

**The failure was not the expensive part — the partial write was.** The job updated table by
table with no transaction, so when it stopped, `gig_attendances`, `gig_catalog`,
`gig_artists` and `gig_venues` had moved and the `objects` rows they point at had not. That
is exactly the split the job exists to prevent: the stream's gigs lane joins
`objects.ap_id = gig_attendances.note_ap_id`, and until the fixed run landed, the public page
had no gigs at all. `rebaseGigOrigin` now runs inside one transaction — all of it or none of
it — which is verified by putting the old constraint back and asserting the row counts do
not move.

The general lesson, and the reason this is written down: **a one-off data migration deserves
a transaction more than a routine job does, not less.** It is the run nobody has rehearsed,
against the one database that matters, and "it failed" is a far cheaper outcome to inherit
than "it half worked".

## Postscript 2 — one URI stays at the old address on purpose

The finished run reported `remaining: 1`, and the row was:

```
activities.ap_id = https://samklang.msge.no/aktivitet/01KZPKJ9Y0FD3PJZXK8FWCFCYQ
```

`/aktivitet/<ULID>` is how the origin mints a **transient activity id** — the wrapper on a
Follow, an Accept, an Undo — with `ulid()` at delivery time. It is in neither `ENTITY_PATHS`
(the entity URI space that moved to English) nor `LEGACY_SEGMENTS` (the redirect map), and no
route serves it at either address. This particular one is the handshake from following
`@markus@samklang.msge.no` on 2026-08-10.

**It must not move**, and `canonicalGigUri` declining it is the closed segment map working as
designed rather than a gap in it. There is nothing at gigowl.social that this identifies;
rewriting it would invent an identifier that has never existed anywhere, in place of a true
record of an activity that really was issued at that address. Renaming an entity that moved
and renaming the receipt for something that happened are not the same operation.

What was wrong was the **check**: `countLegacyGigRows` counted anything still naming the old
origin, so a correct run finished by warning about a row nobody should ever touch. It now
counts only the prefixes the rewrite would actually move — derived from the same segment map,
so SQL and code cannot drift — and a non-zero result means something really was missed. A
check that cries wolf is one nobody reads the second time.
