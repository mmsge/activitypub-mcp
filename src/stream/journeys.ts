import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { config } from '../config.js'
import { publicOnlyOn } from './visibility.js'

/**
 * Journeys — a named group of trips, and everything published on them.
 *
 * A journey exists in two names. `train_trips.journey` is the private one Markus
 * types into viaduct.world ("NDC Copenhagen 2026", "Sjælland rundt"); the hashtag
 * is the public one he posts under (`#kodetoget`, `#nordsjællandrundt`). Nothing
 * links them.
 *
 * They are reconciled here without a mapping table, and without matching the
 * strings — which would fail anyway, since "NDC Copenhagen 2026" and "kodetoget"
 * share no characters. The `trip_posts` join (ADR 0023) already says which posts
 * were made on a journey's trips, so the public name simply *is* the hashtag those
 * posts carry most. It is derived from data, updates itself when Markus starts
 * tagging differently, and cannot go stale the way a hand-written mapping would.
 */

/** A journey as the index page lists it. */
export interface JourneySummary {
  name: string
  slug: string
  trips: number
  km: number
  /** The hashtag those posts carry most, without the '#'. Null when none do. */
  tag: string | null
  posts: number
  firstAt: Date
  lastAt: Date
  stations: string[]
}

/**
 * One leg of a journey, and what was posted on it.
 *
 * The leg is the journey page's chapter: `trip_posts` binds every post to exactly
 * one trip (ADR 0023), so "which chapter does this post belong to" has the same
 * single answer as "which train was I on".
 */
export interface JourneyLeg {
  /** `train_trips.id` — the key `trip_posts` binds posts by. */
  id: string
  fromStation: string
  toStation: string
  departureAt: Date
  /** Null where viaduct.world recorded no arrival; the chapter then has no span. */
  arrivalAt: Date | null
  operator: string | null
  distanceKm: number | null
  night: boolean
  /** Ref ids (`post:<uuid>`) of the posts made on this leg, oldest first. */
  postRefIds: string[]
}

/** One journey's page: the summary, its legs, and what was posted on them. */
export interface JourneyDetail extends JourneySummary {
  operators: string[]
  /** The legs in departure order — the chapters, start at top, end at bottom. */
  legs: JourneyLeg[]
  /** Ref ids of every post made on this journey, oldest first. */
  postRefIds: string[]
}

/**
 * A URL segment for a journey name.
 *
 * Norwegian letters are transliterated rather than percent-encoded: `Sjælland
 * rundt` becomes `sjaelland-rundt`, which survives being copied into a chat window
 * or an email in a way `sj%C3%A6lland-rundt` does not. Lossy on purpose — the slug
 * is only ever compared against other slugs, never turned back into a name.
 */
export function journeySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    // Strip the accents Latin-1 carries (é, è, ñ …) without touching the letters.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The hashtag/post counters, shared by the index and the detail page. */
const TAG_AND_POSTS = sql`
  SELECT
    t.journey AS journey,
    count(DISTINCT tp.object_ap_id)::int AS posts,
    (
      SELECT lower(ltrim(tag->>'name', '#'))
      FROM trip_posts tp2
      JOIN train_trips t2 ON t2.id = tp2.trip_id
      JOIN objects o2 ON o2.ap_id = tp2.object_ap_id
      CROSS JOIN LATERAL jsonb_array_elements(o2.tags) AS tag
      WHERE t2.journey = t.journey
        AND o2.deleted_at IS NULL
        AND jsonb_typeof(o2.tags) = 'array'
        AND lower(tag->>'type') = 'hashtag'
        AND ${publicOnlyOn('o2', config.STREAM_INCLUDE_UNLISTED)}
      GROUP BY lower(ltrim(tag->>'name', '#'))
      -- Most-used wins; the name breaks ties so the page does not flip between
      -- two equally-used tags from one request to the next.
      ORDER BY count(*) DESC, lower(ltrim(tag->>'name', '#')) ASC
      LIMIT 1
    ) AS tag
  FROM trip_posts tp
  JOIN train_trips t ON t.id = tp.trip_id
  JOIN objects o ON o.ap_id = tp.object_ap_id
  WHERE t.journey IS NOT NULL
    AND o.deleted_at IS NULL
    AND ${publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED)}
  GROUP BY t.journey`

/**
 * Every journey with at least one trip, newest first.
 *
 * Trips with no journey name are excluded rather than lumped into an "other"
 * bucket: they are the commuter hops, and a page called "ingen reise" listing 7
 * Arna↔Bergen legs is not a journey.
 */
export async function loadJourneys(): Promise<JourneySummary[]> {
  const db = getDb()
  const rows = (await db.execute(sql`
    WITH counted AS (${TAG_AND_POSTS})
    SELECT
      t.journey AS name,
      count(*)::int AS trips,
      coalesce(sum(t.distance_km), 0)::int AS km,
      min(t.departure_at) AS first_at,
      max(t.departure_at) AS last_at,
      array_agg(DISTINCT t.from_station) AS from_stations,
      array_agg(DISTINCT t.to_station) AS to_stations,
      coalesce(c.posts, 0) AS posts,
      c.tag AS tag
    FROM train_trips t
    LEFT JOIN counted c ON c.journey = t.journey
    WHERE t.journey IS NOT NULL AND t.departure_at <= now()
    GROUP BY t.journey, c.posts, c.tag
    ORDER BY max(t.departure_at) DESC`)) as unknown as Array<Record<string, unknown>>

  return rows.map((r) => toSummary(r))
}

function toSummary(r: Record<string, unknown>): JourneySummary {
  const name = String(r.name)
  const stations = new Set<string>()
  for (const s of [...(r.from_stations as string[] ?? []), ...(r.to_stations as string[] ?? [])]) {
    if (s) stations.add(s)
  }
  return {
    name,
    slug: journeySlug(name),
    trips: Number(r.trips ?? 0),
    km: Number(r.km ?? 0),
    tag: r.tag == null ? null : String(r.tag),
    posts: Number(r.posts ?? 0),
    firstAt: new Date(r.first_at as string),
    lastAt: new Date(r.last_at as string),
    stations: [...stations].sort(),
  }
}

/**
 * One journey by slug, or null.
 *
 * Resolved by slugging the stored names and comparing in JS rather than by
 * slugging in SQL: the transliteration above is not expressible in Postgres
 * without an extension, and there are 13 journeys. Two names that slug the same
 * would collide — the newest wins, which is the same rule the index sorts by.
 */
export async function loadJourney(slug: string): Promise<JourneyDetail | null> {
  const summaries = await loadJourneys()
  const summary = summaries.find((j) => j.slug === slug)
  if (!summary) return null

  const db = getDb()
  const legs = (await db.execute(sql`
    SELECT id::text AS id, from_station, to_station, departure_at, arrival_at,
           operator, distance_km, night
    FROM train_trips
    WHERE journey = ${summary.name} AND departure_at <= now()
    ORDER BY departure_at ASC`)) as unknown as Array<Record<string, unknown>>

  // Posts on this journey, as stream ref ids so the page can reuse the ordinary
  // hydration and renderer rather than growing a second way to draw a post. The
  // trip id comes along so the page can file each post under its leg; `DISTINCT`
  // cannot split a post across two of them, since `trip_posts.object_ap_id` is
  // unique. Oldest first, which is the order the chapters read in.
  //
  // The `departure_at <= now()` here mirrors the legs query above: a post bound to
  // a leg that has not departed yet would otherwise have no chapter to sit in.
  const posts = (await db.execute(sql`
    SELECT DISTINCT o.id::text AS id, o.published_at, tp.trip_id::text AS trip_id
    FROM trip_posts tp
    JOIN train_trips t ON t.id = tp.trip_id
    JOIN objects o ON o.ap_id = tp.object_ap_id
    WHERE t.journey = ${summary.name}
      AND t.departure_at <= now()
      AND o.deleted_at IS NULL
      AND o.published_at IS NOT NULL
      AND o.in_reply_to IS NULL
      AND ${publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED)}
    ORDER BY o.published_at ASC`)) as unknown as Array<{ id: string; trip_id: string }>

  const byTrip = new Map<string, string[]>()
  for (const p of posts) {
    const refIds = byTrip.get(p.trip_id)
    if (refIds) refIds.push(`post:${p.id}`)
    else byTrip.set(p.trip_id, [`post:${p.id}`])
  }

  const operators = new Set<string>()
  for (const l of legs) if (l.operator) operators.add(String(l.operator))

  return {
    ...summary,
    operators: [...operators].sort(),
    legs: legs.map((l) => ({
      id: String(l.id),
      fromStation: String(l.from_station),
      toStation: String(l.to_station),
      departureAt: new Date(l.departure_at as string),
      arrivalAt: l.arrival_at == null ? null : new Date(l.arrival_at as string),
      operator: l.operator == null ? null : String(l.operator),
      distanceKm: l.distance_km == null ? null : Number(l.distance_km),
      night: Boolean(l.night),
      postRefIds: byTrip.get(String(l.id)) ?? [],
    })),
    postRefIds: posts.map((p) => `post:${p.id}`),
  }
}
