import { getDb } from '../db/client.js'
import { gigArtists, gigAttendances, gigCatalog, gigVenues } from '../db/schema.js'
import {
  fetchArtist,
  fetchConcert,
  fetchVenue,
  type GigArtistMetadata,
  type GigConcertMetadata,
  type GigVenueMetadata,
} from '../lib/fetch-samklang.js'
import { logger } from '../lib/logger.js'
import { eq, sql } from 'drizzle-orm'

const MAX_PER_RUN = 200 // bound a single pass so a backfill doesn't hammer the origin
const FETCH_DELAY_MS = 200
// A gig is not a moving target the way a NeoDB catalogue entry is — but a setlist gets
// filled in days later, and the trust queue can rewrite a venue, so the cache does expire.
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── persistence ─────────────────────────────────────────────────────────────────────

/**
 * The values written for an enriched concert.
 *
 * `hiddenAt` is deliberately absent: including it would reset an admin's hide on every
 * enrichment pass, which is exactly the bug ADR 0013 records for catalog_metadata.
 */
export function concertUpsertValues(meta: GigConcertMetadata, now = new Date()) {
  return {
    concertUrl: meta.concertUrl,
    title: meta.title,
    gigDate: meta.gigDate,
    startAt: meta.startAt,
    doorsTime: meta.doorsTime,
    concertStatus: meta.concertStatus,
    tourName: meta.tourName,
    festivalName: meta.festivalName,
    notes: meta.notes,
    venueUrl: meta.venueUrl,
    venueName: meta.venueName,
    venueCity: meta.venueCity,
    venueCountry: meta.venueCountry,
    lineup: meta.lineup,
    artistNames: meta.artistNames,
    setlists: meta.setlists,
    songCount: meta.songCount,
    details: meta.details,
    sourceMap: meta.sourceMap,
    raw: meta.raw as Record<string, unknown>,
    fetchedAt: now,
    enrichedAt: now,
    fetchError: null,
    lastAttemptAt: now,
  }
}

async function upsertConcert(meta: GigConcertMetadata): Promise<void> {
  const values = concertUpsertValues(meta)
  await getDb()
    .insert(gigCatalog)
    .values(values)
    .onConflictDoUpdate({ target: gigCatalog.concertUrl, set: values })
}

async function upsertArtist(meta: GigArtistMetadata): Promise<void> {
  const now = new Date()
  const values = {
    artistUrl: meta.artistUrl,
    name: meta.name,
    sortName: meta.sortName,
    disambiguation: meta.disambiguation,
    artistType: meta.artistType,
    country: meta.country,
    mbid: meta.mbid,
    wikidataQid: meta.wikidataQid,
    beginYear: meta.beginYear,
    endYear: meta.endYear,
    imageUrl: meta.imageUrl,
    imageAttribution: meta.imageAttribution,
    sourceMap: meta.sourceMap,
    raw: meta.raw as Record<string, unknown>,
    fetchedAt: now,
    enrichedAt: now,
    fetchError: null,
    lastAttemptAt: now,
  }
  await getDb()
    .insert(gigArtists)
    .values(values)
    .onConflictDoUpdate({ target: gigArtists.artistUrl, set: values })
}

async function upsertVenue(meta: GigVenueMetadata): Promise<void> {
  const now = new Date()
  const values = {
    venueUrl: meta.venueUrl,
    name: meta.name,
    aka: meta.aka,
    city: meta.city,
    country: meta.country,
    latitude: meta.latitude,
    longitude: meta.longitude,
    capacity: meta.capacity,
    timezone: meta.timezone,
    wikidataQid: meta.wikidataQid,
    isPlaceholder: meta.isPlaceholder,
    sourceMap: meta.sourceMap,
    raw: meta.raw as Record<string, unknown>,
    fetchedAt: now,
    enrichedAt: now,
    fetchError: null,
    lastAttemptAt: now,
  }
  await getDb()
    .insert(gigVenues)
    .values(values)
    .onConflictDoUpdate({ target: gigVenues.venueUrl, set: values })
}

/**
 * Record a failed fetch rather than letting the URL vanish.
 *
 * A failure row is visible in the admin and is retried on the next pass; dropping it
 * would leave a gig referenced by an attendance with nothing to join to and no trace of
 * why.
 */
async function recordConcertFailure(concertUrl: string, error: string): Promise<void> {
  const now = new Date()
  await getDb()
    .insert(gigCatalog)
    .values({
      concertUrl,
      raw: {},
      fetchedAt: now,
      enrichedAt: null,
      fetchError: error,
      fetchAttempts: 1,
      lastAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: gigCatalog.concertUrl,
      set: {
        fetchError: error,
        fetchAttempts: sql`${gigCatalog.fetchAttempts} + 1`,
        lastAttemptAt: now,
        fetchedAt: now,
      },
    })
  logger.warn({ concertUrl, error }, 'Recorded failed gig enrichment (retryable)')
}

// ─── enrichment ──────────────────────────────────────────────────────────────────────

/**
 * Fetch and persist one concert, then its venue and every artist in its line-up.
 *
 * The artist and venue fetches are best-effort and never fail the concert: an origin that
 * has not yet deployed Gigowl's ADR 0026 answers HTML for those URLs, in which case the
 * gig is still perfectly usable from the concert record alone.
 */
export async function enrichGig(concertUrl: string): Promise<GigConcertMetadata | null> {
  const meta = await fetchConcert(concertUrl)
  if (!meta) {
    await recordConcertFailure(concertUrl, 'fetch failed or returned no JSON')
    return null
  }
  await upsertConcert(meta)

  if (meta.venueUrl) {
    const venue = await fetchVenue(meta.venueUrl)
    if (venue) await upsertVenue(venue)
  }

  const artistUrls = new Set<string>()
  for (const member of meta.lineup) if (member.artistUrl) artistUrls.add(member.artistUrl)
  for (const url of (meta.details.artistUris as string[] | undefined) ?? []) artistUrls.add(url)
  for (const url of artistUrls) {
    const artist = await fetchArtist(url)
    if (artist) await upsertArtist(artist)
    await sleep(FETCH_DELAY_MS)
  }

  return meta
}

// --- On-ingest enrichment ----------------------------------------------------
//
// Serialized through one promise chain and deduped per process, so a burst of
// attendances for the same gig (a backfill, an outbox crawl) makes one request.

const attempted = new Set<string>()
let ingestQueue: Promise<void> = Promise.resolve()

export function queueGigEnrichment(concertUrl: string): void {
  if (!concertUrl || attempted.has(concertUrl)) return
  attempted.add(concertUrl)
  ingestQueue = ingestQueue
    .then(() => enrichIfNeeded(concertUrl))
    .catch((e) => logger.warn({ concertUrl, error: e }, 'On-ingest gig enrichment failed'))
}

async function enrichIfNeeded(concertUrl: string): Promise<void> {
  const existing = await getDb()
    .select({ enrichedAt: gigCatalog.enrichedAt, fetchError: gigCatalog.fetchError })
    .from(gigCatalog)
    .where(eq(gigCatalog.concertUrl, concertUrl))
    .limit(1)
  // Already enriched cleanly → leave staleness to the periodic sync.
  if (existing[0]?.enrichedAt && !existing[0].fetchError) return

  const meta = await enrichGig(concertUrl)
  if (meta) {
    logger.info({ concertUrl, title: meta.title, gigDate: meta.gigDate }, 'Enriched gig on ingest')
  }
  await sleep(FETCH_DELAY_MS)
}

// --- Periodic sync -----------------------------------------------------------

/** Every concert URL a stored attendance references, tombstoned ones included. */
async function collectConcertUrls(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ concertUrl: gigAttendances.concertUrl })
    .from(gigAttendances)
  return rows.map((r) => r.concertUrl)
}

export async function syncGigMetadata(force = false): Promise<void> {
  const referenced = await collectConcertUrls()
  if (referenced.length === 0) {
    logger.info('No gigs referenced yet, skipping gig metadata sync')
    return
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const rows = force
    ? []
    : await getDb()
        .select({
          concertUrl: gigCatalog.concertUrl,
          enrichedAt: gigCatalog.enrichedAt,
          fetchError: gigCatalog.fetchError,
        })
        .from(gigCatalog)
  const fresh = new Set(
    rows.filter((r) => r.enrichedAt && !r.fetchError && r.enrichedAt >= cutoff).map((r) => r.concertUrl),
  )

  const todo = referenced.filter((url) => !fresh.has(url))
  const batch = todo.slice(0, force ? todo.length : MAX_PER_RUN)

  logger.info(
    { referenced: referenced.length, stale_or_missing: todo.length, batch: batch.length, force },
    'Starting gig metadata sync',
  )

  let enriched = 0
  let failed = 0
  for (const concertUrl of batch) {
    if (await enrichGig(concertUrl)) enriched++
    else failed++
    await sleep(FETCH_DELAY_MS)
  }

  logger.info({ enriched, failed, referenced: referenced.length }, 'Gig metadata sync complete')
}
