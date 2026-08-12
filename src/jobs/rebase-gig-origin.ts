import { getDb } from '../db/client.js'
import {
  activities,
  follows,
  gigArtists,
  gigAttendances,
  gigCatalog,
  gigVenues,
  objects,
} from '../db/schema.js'
import { eq, like, or, sql, type Column, type SQL } from 'drizzle-orm'
import { LEGACY_GIG_ORIGIN, canonicalGigUri } from '../lib/gig-attendance.js'
import { logger } from '../lib/logger.js'

/**
 * Move every stored Gigowl identifier onto the origin's current address.
 *
 * Gigowl changed domain and, in the same window, moved its whole URI space from Nynorsk to
 * English (its ADR 0029 and 0030): `https://samklang.msge.no/konsert/<ULID>` is now
 * `https://gigowl.social/gig/<ULID>`. The old address 301s, so nothing here broke — but the
 * store is KEYED on these strings, and a key does not follow a redirect. Left alone, the
 * first re-delivered attendance would open a second row beside the one that has the
 * write-up, the photos and the setlist on it, and the stream's `gigs` lane — which matches
 * attendances against the actor id `@markus@gigowl.social` resolves to — would find none of
 * the archive at all.
 *
 * A one-off maintenance operation for one deployment that changed address, deliberately NOT
 * a Drizzle migration: it is not a schema change every database needs, and a migration with
 * one origin's domain baked into it would run on every fresh database and mean nothing
 * there. The origin reached the same conclusion for its own half (`scripts/rebase-origin.sql`
 * over there). Idempotent, so a second run is a no-op rather than a hazard:
 *
 *   npm run rebase-gig-origin          # rewrite
 *   DRY_RUN=1 npm run rebase-gig-origin # count what would be rewritten, change nothing
 *
 * ── What it deliberately leaves alone ──────────────────────────────────────────────────
 *
 *   - **`raw` and `tags`**, everywhere. Those columns are the document as it was delivered,
 *     and provenance that has been edited is not provenance. `parseGigAttendance` moves the
 *     identifiers as it reads them, so replaying an old payload — which is exactly what the
 *     local-first backfill does — still lands on the rebased row.
 *   - **The `actors` row for the old account.** It is a truthful record of an account that
 *     existed at that address; the new one arrives when the new follow resolves.
 *   - **`https://samklang.msge.no/ns#`**, the JSON-LD vocabulary. A vocabulary identifier
 *     shared by every instance of the software, not an address on one of them — frozen at
 *     the origin, and `canonicalGigUri` will not touch it.
 */
export interface GigOriginRebaseResult {
  gigAttendances: number
  gigCatalog: number
  gigArtists: number
  gigVenues: number
  objects: number
  activities: number
  /** Follow rows for the old address, dropped rather than rewritten. */
  followsDropped: number
  dryRun: boolean
}

/** Any string under the old origin, however deep in a JSON value, moved to the new one. */
export function rebaseJsonValue<T>(value: T): T {
  if (typeof value === 'string') return canonicalGigUri(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => rebaseJsonValue(v)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rebaseJsonValue(v)]),
    ) as unknown as T
  }
  return value
}

const legacy = `${LEGACY_GIG_ORIGIN}/%`

/** `col LIKE 'https://samklang.msge.no/%'` for any of the given columns. */
function onLegacyOrigin(...columns: Column[]): SQL {
  return or(...columns.map((c) => like(c, legacy)))!
}

/**
 * Rewrite one table's URI columns, plus any JSON columns that carry URIs inside them.
 *
 * Row by row rather than a SQL `replace()`: the rewrite is a segment map, not a string
 * substitution, and running the same `canonicalGigUri` the ingest path runs is the only way
 * to be sure the two cannot drift. The volume is a few dozen rows.
 */
async function rebaseRows<Row extends { id: string }>(
  rows: Row[],
  keys: (keyof Row)[],
  jsonKeys: (keyof Row)[],
  apply: (id: string, patch: Partial<Row>) => Promise<void>,
  dryRun: boolean,
): Promise<number> {
  let changed = 0
  for (const row of rows) {
    const patch: Partial<Row> = {}
    for (const key of keys) {
      const value = row[key]
      if (typeof value !== 'string') continue
      const moved = canonicalGigUri(value)
      if (moved !== value) patch[key] = moved as Row[typeof key]
    }
    for (const key of jsonKeys) {
      const value = row[key]
      if (value == null) continue
      const moved = rebaseJsonValue(value)
      if (JSON.stringify(moved) !== JSON.stringify(value)) patch[key] = moved
    }
    if (Object.keys(patch).length === 0) continue
    changed++
    if (!dryRun) await apply(row.id, patch)
  }
  return changed
}

/**
 * All of it, or none of it.
 *
 * The first production run stopped halfway — a foreign key on `trip_posts` refused the
 * `objects` update (see migration 0031) — leaving the gig tables rebased and the Notes they
 * point at still at the old address, which is precisely the split this whole job exists to
 * prevent: the stream's gigs lane joins the two, so the public page lost every gig. Nothing
 * here is a long operation and the row counts are in the dozens, so there is no reason for
 * it ever to be observable half-done.
 */
export async function rebaseGigOrigin(opts: { dryRun?: boolean } = {}): Promise<GigOriginRebaseResult> {
  return getDb().transaction((tx) => rebaseInTransaction(tx, opts.dryRun ?? false))
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

async function rebaseInTransaction(db: Tx, dryRun: boolean): Promise<GigOriginRebaseResult> {
  const attendanceRows = await db
    .select({
      id: gigAttendances.id,
      concertUrl: gigAttendances.concertUrl,
      actorApId: gigAttendances.actorApId,
      noteApId: gigAttendances.noteApId,
      noteUrl: gigAttendances.noteUrl,
      photos: gigAttendances.photos,
    })
    .from(gigAttendances)
    .where(
      onLegacyOrigin(
        gigAttendances.concertUrl,
        gigAttendances.actorApId,
        gigAttendances.noteApId,
        gigAttendances.noteUrl,
      ),
    )

  const catalogRows = await db
    .select({
      id: gigCatalog.id,
      concertUrl: gigCatalog.concertUrl,
      venueUrl: gigCatalog.venueUrl,
      lineup: gigCatalog.lineup,
      setlists: gigCatalog.setlists,
      details: gigCatalog.details,
    })
    .from(gigCatalog)
    .where(onLegacyOrigin(gigCatalog.concertUrl, gigCatalog.venueUrl))

  const artistRows = await db
    .select({ id: gigArtists.id, artistUrl: gigArtists.artistUrl, imageUrl: gigArtists.imageUrl })
    .from(gigArtists)
    .where(onLegacyOrigin(gigArtists.artistUrl, gigArtists.imageUrl))

  const venueRows = await db
    .select({ id: gigVenues.id, venueUrl: gigVenues.venueUrl })
    .from(gigVenues)
    .where(onLegacyOrigin(gigVenues.venueUrl))

  // The attendance Notes themselves, as ordinary stored posts. The stream's gigs lane joins
  // `objects.ap_id = gig_attendances.note_ap_id`, so these two move together or the gigs
  // vanish from the public page.
  const objectRows = await db
    .select({ id: objects.id, apId: objects.apId, actorApId: objects.actorApId, url: objects.url })
    .from(objects)
    .where(onLegacyOrigin(objects.apId, objects.actorApId, objects.url))

  const activityRows = await db
    .select({
      id: activities.id,
      apId: activities.apId,
      actorApId: activities.actorApId,
      objectApId: activities.objectApId,
    })
    .from(activities)
    .where(onLegacyOrigin(activities.apId, activities.actorApId, activities.objectApId))

  const result: GigOriginRebaseResult = {
    gigAttendances: await rebaseRows(
      attendanceRows,
      ['concertUrl', 'actorApId', 'noteApId', 'noteUrl'],
      ['photos'],
      (id, patch) => db.update(gigAttendances).set(patch).where(eq(gigAttendances.id, id)).then(() => undefined),
      dryRun,
    ),
    gigCatalog: await rebaseRows(
      catalogRows,
      ['concertUrl', 'venueUrl'],
      ['lineup', 'setlists', 'details'],
      (id, patch) => db.update(gigCatalog).set(patch).where(eq(gigCatalog.id, id)).then(() => undefined),
      dryRun,
    ),
    gigArtists: await rebaseRows(
      artistRows,
      ['artistUrl', 'imageUrl'],
      [],
      (id, patch) => db.update(gigArtists).set(patch).where(eq(gigArtists.id, id)).then(() => undefined),
      dryRun,
    ),
    gigVenues: await rebaseRows(
      venueRows,
      ['venueUrl'],
      [],
      (id, patch) => db.update(gigVenues).set(patch).where(eq(gigVenues.id, id)).then(() => undefined),
      dryRun,
    ),
    objects: await rebaseRows(
      objectRows,
      ['apId', 'actorApId', 'url'],
      [],
      (id, patch) => db.update(objects).set(patch).where(eq(objects.id, id)).then(() => undefined),
      dryRun,
    ),
    activities: await rebaseRows(
      activityRows,
      ['apId', 'actorApId', 'objectApId'],
      [],
      (id, patch) => db.update(activities).set(patch).where(eq(activities.id, id)).then(() => undefined),
      dryRun,
    ),
    followsDropped: 0,
    dryRun,
  }

  // The follow is DROPPED, never rewritten.
  //
  // Rewriting it would claim an accepted follow of an actor that has never seen a Follow
  // from us — the origin's ADR 0030 is explicit that a 301 does not rescue federation, so
  // the new server holds no follower record and would deliver us nothing, while our own
  // table said "accepted" forever. Dropping it lets syncFollows send a real Follow to
  // `@markus@gigowl.social` on the next boot and get a real Accept back.
  //
  // No Undo is sent to the old address: there is no server there any more to receive it,
  // only a redirect to the new one, which would be asked to undo a follow it never had.
  const stale = await db.select({ actorApId: follows.actorApId }).from(follows).where(like(follows.actorApId, legacy))
  result.followsDropped = stale.length
  if (!dryRun && stale.length > 0) {
    await db.delete(follows).where(like(follows.actorApId, legacy))
  }

  const total = result.gigAttendances + result.gigCatalog + result.gigArtists + result.gigVenues
    + result.objects + result.activities
  if (total === 0 && result.followsDropped === 0) {
    logger.info('Gig origin rebase: nothing left on the old address')
  } else {
    logger.info({ ...result, staleFollows: stale.map((f) => f.actorApId) }, 'Gig origin rebase complete')
  }
  return result
}

/** How many rows still name the old origin anywhere the rebase looks. For the script's
 *  closing check: a non-zero count after a real run means something was missed. */
export async function countLegacyGigRows(): Promise<number> {
  const [row] = await getDb().execute<{ count: number }>(sql`
    SELECT (
      (SELECT count(*) FROM gig_attendances
        WHERE concert_url LIKE ${legacy} OR actor_ap_id LIKE ${legacy}
           OR note_ap_id LIKE ${legacy} OR note_url LIKE ${legacy})
    + (SELECT count(*) FROM gig_catalog WHERE concert_url LIKE ${legacy} OR venue_url LIKE ${legacy})
    + (SELECT count(*) FROM gig_artists WHERE artist_url LIKE ${legacy} OR image_url LIKE ${legacy})
    + (SELECT count(*) FROM gig_venues WHERE venue_url LIKE ${legacy})
    + (SELECT count(*) FROM objects
        WHERE ap_id LIKE ${legacy} OR actor_ap_id LIKE ${legacy} OR url LIKE ${legacy})
    + (SELECT count(*) FROM activities
        WHERE ap_id LIKE ${legacy} OR actor_ap_id LIKE ${legacy} OR object_ap_id LIKE ${legacy})
    + (SELECT count(*) FROM follows WHERE actor_ap_id LIKE ${legacy})
    )::int AS count`)
  return Number(row?.count ?? 0)
}
