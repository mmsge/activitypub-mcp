import { sql, and, eq, inArray, isNull, asc, gte, lt } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  objects, actors, bookwyrmObjects, bookMetadata, neodbMarks,
  catalogMetadata, scrobbles, trainTrips, gardenNotes,
} from '../db/schema.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { encodeCursor } from '../mcp/tools/pagination.js'
import { stripHtml } from '../lib/strip-html.js'
import { mergedCandidateSql, type LaneContext } from './lanes.js'
import { sanitizeHtml } from './sanitize-html.js'
import { publicOnlyCondition } from './visibility.js'
import { parseSources, AP_PLATFORMS, type ApPlatform, type Platform } from './sources.js'
import { osloDay } from './event-date.js'
import type { Facets } from './facets.js'
import type {
  Attachment, Candidate, Entry, StreamPage,
  PostEntry, BookEntry, MarkEntry, ScrobbleDayEntry, TripEntry, GardenEntry,
} from './entries.js'

/**
 * Run one page of the public stream.
 *
 * Two steps, deliberately. First a k-way merge over the lanes (see lanes.ts) that
 * returns only `(event_at, kind, ref_id, source)` — enough to decide *which*
 * entries are on this page and in what order. Then one hydration query per kind
 * for the ≤20 winners. A single wide union carrying every column of six unrelated
 * tables would be slower and much easier to get a privacy rule wrong in.
 */

type ActorIds = LaneContext['actorIds']

const EMPTY_ACTOR_IDS: ActorIds = Object.fromEntries(AP_PLATFORMS.map((p) => [p, [] as string[]])) as ActorIds

let actorIdCache: { at: number; ids: ActorIds } | null = null
const ACTOR_CACHE_MS = 10 * 60 * 1000

/**
 * Resolve the allowlisted handles to AP ids, from the `actors` table the bot
 * already keeps. Cached for ten minutes — the set changes only when Markus edits
 * the config and redeploys.
 *
 * A handle that resolves to nothing is dropped with a warning rather than
 * guessed at: a wrong id here would publish the wrong account's posts.
 */
export async function resolveActorIds(): Promise<ActorIds> {
  if (actorIdCache && Date.now() - actorIdCache.at < ACTOR_CACHE_MS) return actorIdCache.ids

  const sources = parseSources(config.STREAM_SOURCES)
  const ids: ActorIds = Object.fromEntries(AP_PLATFORMS.map((p) => [p, [] as string[]])) as ActorIds
  if (sources.length === 0) {
    actorIdCache = { at: Date.now(), ids }
    return ids
  }

  const db = getDb()
  const rows = await db
    .select({ apId: actors.apId, handle: actors.handle })
    .from(actors)

  const byHandle = new Map<string, string>()
  for (const r of rows) {
    if (r.handle) byHandle.set(r.handle.toLowerCase().replace(/^@?/, '@'), r.apId)
  }

  for (const s of sources) {
    const apId = byHandle.get(s.handle.toLowerCase())
    if (!apId) {
      logger.warn({ handle: s.handle }, 'STREAM_SOURCES handle is not a known actor; excluded from the stream')
      continue
    }
    ids[s.platform as ApPlatform].push(apId)
  }
  actorIdCache = { at: Date.now(), ids }
  return ids
}

/** Test seam and admin "re-read config" hook. */
export function clearActorIdCache(): void {
  actorIdCache = null
}

/** Normalise the AP `attachment` array into what the views render. */
export function toAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue
    const att = a as Record<string, unknown>
    const url = typeof att.url === 'string'
      ? att.url
      : (att.url && typeof att.url === 'object' && typeof (att.url as Record<string, unknown>).href === 'string'
          ? ((att.url as Record<string, unknown>).href as string)
          : null)
    if (!url || !/^https?:\/\//i.test(url)) continue
    out.push({
      url,
      mediaType: typeof att.mediaType === 'string' ? att.mediaType : null,
      // The author's own alt text. Rendering media without it would drop
      // accessibility information Markus actually wrote.
      alt: typeof att.name === 'string' ? att.name : null,
      width: typeof att.width === 'number' ? att.width : null,
      height: typeof att.height === 'number' ? att.height : null,
      blurhash: typeof att.blurhash === 'string' ? att.blurhash : null,
    })
  }
  return out
}

/** Hashtag names from the raw AP `tag` array. Mentions and emoji are ignored. */
export function toHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const tag = t as Record<string, unknown>
    if (String(tag.type).toLowerCase() !== 'hashtag') continue
    if (typeof tag.name === 'string') out.push(tag.name.replace(/^#/, ''))
  }
  return out
}

function ratingOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null
}

/** Split "<prefix>:<id>" back into its parts. */
function refParts(refId: string): { prefix: string; id: string } {
  const at = refId.indexOf(':')
  return { prefix: refId.slice(0, at), id: refId.slice(at + 1) }
}

// ── Hydration ───────────────────────────────────────────────────────────────

async function hydratePosts(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const ids = cands.map((c) => refParts(c.refId).id)
  const db = getDb()

  const rows = await db
    .select({
      id: objects.id, apId: objects.apId, content: objects.content, summary: objects.summary,
      url: objects.url, publishedAt: objects.publishedAt, createdAt: objects.createdAt,
      attachments: objects.attachments, tags: objects.tags, sensitive: objects.sensitive,
      language: objects.language, actorApId: objects.actorApId,
    })
    .from(objects)
    .where(inArray(objects.id, ids))

  // Later parts of Markus' own threads, folded into their root rather than
  // appearing as separate entries.
  //
  // Walked level by level, not in one pass: the third post of a thread replies to
  // the second, not to the root, so fetching direct children alone would silently
  // truncate every thread longer than two. Bounded so a pathological chain cannot
  // spin. Each level carries the same visibility and actor conditions as the root,
  // so a private post cannot be pulled into a public thread — and its descendants
  // stop with it.
  const MAX_THREAD_DEPTH = 20
  type ThreadRow = {
    apId: string; actorApId: string; content: string | null; url: string | null
    inReplyTo: string | null; attachments: unknown; publishedAt: Date | null
  }
  const byParent = new Map<string, ThreadRow[]>()
  let frontier = rows.map((r) => ({ apId: r.apId, actorApId: r.actorApId }))
  const visited = new Set<string>(frontier.map((f) => f.apId))

  for (let depth = 0; depth < MAX_THREAD_DEPTH && frontier.length > 0; depth++) {
    const parentIds = frontier.map((f) => f.apId)
    const children: ThreadRow[] = await db
      .select({
        apId: objects.apId, actorApId: objects.actorApId, content: objects.content,
        url: objects.url, inReplyTo: objects.inReplyTo,
        attachments: objects.attachments, publishedAt: objects.publishedAt,
      })
      .from(objects)
      .where(and(
        inArray(objects.inReplyTo, parentIds),
        isNull(objects.deletedAt),
        publicOnlyCondition(config.STREAM_INCLUDE_UNLISTED),
      ))
      .orderBy(asc(objects.publishedAt))

    const parentActor = new Map(frontier.map((f) => [f.apId, f.actorApId]))
    const next: Array<{ apId: string; actorApId: string }> = []
    for (const c of children) {
      // Same author as the post it answers — someone else replying to Markus is
      // not part of his thread.
      if (!c.inReplyTo || parentActor.get(c.inReplyTo) !== c.actorApId) continue
      if (visited.has(c.apId)) continue // a cycle, or a diamond; either way, once
      visited.add(c.apId)
      const list = byParent.get(c.inReplyTo) ?? []
      list.push(c)
      byParent.set(c.inReplyTo, list)
      next.push({ apId: c.apId, actorApId: c.actorApId })
    }
    frontier = next
  }

  /** Flatten a root's thread into reading order. */
  const threadOf = (rootApId: string): ThreadRow[] => {
    const out: ThreadRow[] = []
    const walk = (apId: string) => {
      for (const child of byParent.get(apId) ?? []) {
        out.push(child)
        walk(child.apId)
      }
    }
    walk(rootApId)
    return out
  }

  for (const c of cands) {
    const { id } = refParts(c.refId)
    const row = rows.find((r) => r.id === id)
    if (!row) continue
    const entry: PostEntry = {
      refId: c.refId,
      eventAt: c.eventAt,
      archivedAt: row.createdAt,
      source: c.source as Platform,
      originUrl: row.url ?? row.apId,
      kind: c.kind as PostEntry['kind'],
      html: sanitizeHtml(row.content),
      contentWarning: row.summary || null,
      sensitive: Boolean(row.sensitive) || Boolean(row.summary),
      language: row.language,
      attachments: toAttachments(row.attachments),
      hashtags: toHashtags(row.tags),
      thread: threadOf(row.apId).map((r) => ({
        html: sanitizeHtml(r.content),
        attachments: toAttachments(r.attachments),
        originUrl: r.url,
      })),
    }
    out.set(c.refId, entry)
  }
  return out
}

async function hydrateBooks(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const ids = cands.map((c) => refParts(c.refId).id)
  const db = getDb()

  const rows = await db
    .select({
      id: objects.id, apId: objects.apId, content: objects.content, summary: objects.summary,
      url: objects.url, createdAt: objects.createdAt, tags: objects.tags,
      rating: sql<string | null>`coalesce(${bookwyrmObjects.rating}::text, ${objects.raw}->>'rating')`,
      reviewTitle: sql<string | null>`${objects.raw}->>'name'`,
      quote: sql<string | null>`${objects.raw}->>'quote'`,
      inReplyToBook: sql<string | null>`${objects.raw}->>'inReplyToBook'`,
    })
    .from(objects)
    .leftJoin(bookwyrmObjects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(inArray(objects.id, ids))

  // The book each event is about: `inReplyToBook` for reviews/comments, the
  // Edition tag for the generated start/finish notes.
  const bookUrlFor = (row: (typeof rows)[number]): string | null => {
    if (row.inReplyToBook) return row.inReplyToBook
    const tags = Array.isArray(row.tags) ? row.tags : []
    for (const t of tags) {
      if (t && typeof t === 'object') {
        const tag = t as Record<string, unknown>
        if (tag.type === 'Edition' && typeof tag.href === 'string') return tag.href
      }
    }
    return null
  }

  const bookUrls = [...new Set(rows.map(bookUrlFor).filter((u): u is string => !!u))]
  const meta = bookUrls.length
    ? await db
        .select()
        .from(bookMetadata)
        .where(and(inArray(bookMetadata.bookUrl, bookUrls), isNull(bookMetadata.hiddenAt)))
    : []
  const metaByUrl = new Map(meta.map((m) => [m.bookUrl, m]))

  for (const c of cands) {
    const { id } = refParts(c.refId)
    const row = rows.find((r) => r.id === id)
    if (!row) continue
    const bookUrl = bookUrlFor(row)
    const m = bookUrl ? metaByUrl.get(bookUrl) : undefined
    const entry: BookEntry = {
      refId: c.refId,
      eventAt: c.eventAt,
      archivedAt: row.createdAt,
      source: 'bookwyrm',
      originUrl: row.url ?? row.apId,
      kind: c.kind as BookEntry['kind'],
      title: m?.title ?? null,
      author: m?.author ?? null,
      coverUrl: m?.coverUrl ?? null,
      rating: ratingOf(row.rating),
      reviewTitle: row.reviewTitle,
      html: c.kind === 'book_review' || c.kind === 'book_quote' ? sanitizeHtml(row.content) : null,
      quote: row.quote ? stripHtml(row.quote) : null,
      pages: m?.pages ?? null,
      pubYear: m?.pubYear ?? null,
      series: m?.series ?? null,
      bookUrl,
      contentWarning: row.summary || null,
    }
    out.set(c.refId, entry)
  }
  return out
}

async function hydrateMarks(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const ids = cands.map((c) => refParts(c.refId).id)
  const db = getDb()

  const rows = await db
    .select({
      id: neodbMarks.id, itemUrl: neodbMarks.itemUrl, title: neodbMarks.title,
      coverUrl: neodbMarks.coverUrl, category: neodbMarks.category, comment: neodbMarks.comment,
      markUrl: neodbMarks.markUrl, markApId: neodbMarks.markApId, createdAt: neodbMarks.createdAt,
      cmTitle: catalogMetadata.displayTitle, cmCover: catalogMetadata.coverUrl,
      cmYear: catalogMetadata.year, cmRating: catalogMetadata.rating,
      cmDirector: catalogMetadata.director, cmGenre: catalogMetadata.genre,
    })
    .from(neodbMarks)
    .leftJoin(catalogMetadata, eq(catalogMetadata.itemUrl, neodbMarks.itemUrl))
    .where(inArray(neodbMarks.id, ids))

  for (const c of cands) {
    const { id } = refParts(c.refId)
    const row = rows.find((r) => r.id === id)
    if (!row) continue
    const director = Array.isArray(row.cmDirector) ? (row.cmDirector as string[])[0] ?? null : null
    const entry: MarkEntry = {
      refId: c.refId,
      eventAt: c.eventAt,
      archivedAt: row.createdAt,
      source: 'neodb',
      originUrl: row.markUrl ?? row.markApId,
      kind: c.kind as MarkEntry['kind'],
      title: row.cmTitle ?? row.title,
      coverUrl: row.cmCover ?? row.coverUrl,
      category: row.category,
      year: row.cmYear ?? null,
      comment: row.comment,
      rating: ratingOf(row.cmRating),
      director,
      genre: Array.isArray(row.cmGenre) ? (row.cmGenre as string[]).slice(0, 3) : [],
      itemUrl: row.itemUrl,
    }
    out.set(c.refId, entry)
  }
  return out
}

async function hydrateScrobbleDays(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const db = getDb()

  for (const c of cands) {
    const day = refParts(c.refId).id
    // The Oslo day as a half-open UTC range, so the query uses the played_at index.
    const start = c.eventAt
    const end = new Date(start.getTime() + 26 * 60 * 60 * 1000)
    const rows = await db
      .select({
        trackName: scrobbles.trackName, artistName: scrobbles.artistName,
        albumName: scrobbles.albumName, imageUrl: scrobbles.imageUrl, playedAt: scrobbles.playedAt,
      })
      .from(scrobbles)
      .where(and(gte(scrobbles.playedAt, start), lt(scrobbles.playedAt, end)))
      .orderBy(asc(scrobbles.playedAt))

    // The +26h window can spill into the next day at a DST edge; keep only the day.
    const ofDay = rows.filter((r) => osloDay(r.playedAt) === day)
    if (ofDay.length === 0) continue

    const byArtist = new Map<string, { plays: number; imageUrl: string | null }>()
    for (const r of ofDay) {
      const cur = byArtist.get(r.artistName) ?? { plays: 0, imageUrl: null }
      cur.plays++
      cur.imageUrl ??= r.imageUrl
      byArtist.set(r.artistName, cur)
    }

    const entry: ScrobbleDayEntry = {
      refId: c.refId,
      eventAt: c.eventAt,
      archivedAt: ofDay[ofDay.length - 1].playedAt,
      source: 'lastfm',
      originUrl: config.LASTFM_USERNAME ? `https://www.last.fm/user/${config.LASTFM_USERNAME}` : null,
      kind: 'scrobble_day',
      day,
      playCount: ofDay.length,
      topArtists: [...byArtist.entries()]
        .map(([artist, v]) => ({ artist, plays: v.plays, imageUrl: v.imageUrl }))
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 4),
      tracks: ofDay.map((r) => ({
        track: r.trackName, artist: r.artistName, album: r.albumName, playedAt: r.playedAt,
      })),
    }
    out.set(c.refId, entry)
  }
  return out
}

async function hydrateTrips(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const db = getDb()
  const rows = await db
    .select()
    .from(trainTrips)
    .where(inArray(trainTrips.id, cands.map((c) => refParts(c.refId).id)))

  for (const c of cands) {
    const row = rows.find((r) => r.id === refParts(c.refId).id)
    if (!row) continue
    const entry: TripEntry = {
      refId: c.refId, eventAt: c.eventAt, archivedAt: row.createdAt, source: 'tog',
      originUrl: null, kind: 'trip',
      fromStation: row.fromStation, toStation: row.toStation, journey: row.journey,
      operator: row.operator, distanceKm: row.distanceKm, mode: row.mode, night: row.night,
    }
    out.set(c.refId, entry)
  }
  return out
}

async function hydrateGarden(cands: Candidate[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  if (cands.length === 0) return out
  const db = getDb()
  const rows = await db
    .select()
    .from(gardenNotes)
    .where(inArray(gardenNotes.id, cands.map((c) => refParts(c.refId).id)))

  for (const c of cands) {
    const row = rows.find((r) => r.id === refParts(c.refId).id)
    if (!row) continue
    // First prose paragraph, frontmatter removed.
    const body = (row.content ?? '').replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    const excerpt = body ? `${body.split(/\n\s*\n/)[0].slice(0, 280).trim()}${body.length > 280 ? '…' : ''}` : null
    const entry: GardenEntry = {
      refId: c.refId, eventAt: c.eventAt, archivedAt: row.updatedAt, source: 'hage',
      originUrl: `https://markus.plus${row.path}`, kind: 'garden',
      title: row.title, path: row.path, excerpt,
      tags: Array.isArray(row.noteTags) ? (row.noteTags as string[]) : [],
    }
    out.set(c.refId, entry)
  }
  return out
}

const HYDRATORS: Record<string, (c: Candidate[]) => Promise<Map<string, Entry>>> = {
  post: hydratePosts,
  book: hydrateBooks,
  mark: hydrateMarks,
  scrobbleday: hydrateScrobbleDays,
  trip: hydrateTrips,
  garden: hydrateGarden,
}

// ── The page ────────────────────────────────────────────────────────────────

export async function loadStreamPage(facets: Facets): Promise<StreamPage> {
  const actorIds = await resolveActorIds().catch((e) => {
    // A malformed STREAM_SOURCES must not serve a page built from a partial
    // allowlist. Fail to an empty stream instead.
    logger.error(e, 'Could not resolve stream sources; serving nothing')
    return EMPTY_ACTOR_IDS
  })

  // Ask each lane for one more than we need, so we can tell whether another page
  // exists without a second count query.
  const wanted = facets.limit
  const ctx: LaneContext = {
    facets: { ...facets, limit: wanted + 1 },
    actorIds,
    limit: wanted + 1,
  }

  const merged = mergedCandidateSql(ctx)
  if (!merged) return { entries: [], nextCursor: null }

  const db = getDb()
  const raw = (await db.execute(merged)) as unknown as Array<{
    event_at: string | Date; kind: string; ref_id: string; source: string
  }>

  const candidates: Candidate[] = raw.map((r) => ({
    eventAt: r.event_at instanceof Date ? r.event_at : new Date(r.event_at),
    kind: r.kind as Candidate['kind'],
    refId: r.ref_id,
    source: r.source,
  }))

  const hasMore = candidates.length > wanted
  const page = candidates.slice(0, wanted)

  // One hydration query per prefix, then reassemble in the merged order.
  const byPrefix = new Map<string, Candidate[]>()
  for (const c of page) {
    const { prefix } = refParts(c.refId)
    const list = byPrefix.get(prefix) ?? []
    list.push(c)
    byPrefix.set(prefix, list)
  }

  const hydrated = new Map<string, Entry>()
  await Promise.all(
    [...byPrefix.entries()].map(async ([prefix, cands]) => {
      const hydrate = HYDRATORS[prefix]
      if (!hydrate) {
        logger.warn({ prefix }, 'Stream candidate has no hydrator; dropped')
        return
      }
      for (const [k, v] of await hydrate(cands)) hydrated.set(k, v)
    }),
  )

  const entries = page.map((c) => hydrated.get(c.refId)).filter((e): e is Entry => e != null)
  const last = page[page.length - 1]
  return {
    entries,
    nextCursor: hasMore && last ? encodeCursor(last.eventAt, last.refId) : null,
  }
}

/** Months that have at least one entry, newest first — for the sitemap. */
export async function loadArchiveMonths(): Promise<string[]> {
  const db = getDb()
  const rows = (await db.execute(sql`
    SELECT to_char(m, 'YYYY-MM') AS month FROM (
      SELECT date_trunc('month', published_at) AS m FROM objects
      WHERE published_at IS NOT NULL AND deleted_at IS NULL
        AND ${publicOnlyCondition(config.STREAM_INCLUDE_UNLISTED)}
      UNION
      SELECT date_trunc('month', coalesce(watched_at, published_at)) FROM neodb_marks
      WHERE deleted_at IS NULL AND coalesce(watched_at, published_at) IS NOT NULL
      UNION
      SELECT date_trunc('month', departure_at) FROM train_trips
    ) AS months
    WHERE m IS NOT NULL
    ORDER BY m DESC
  `)) as unknown as Array<{ month: string }>
  return rows.map((r) => r.month)
}
