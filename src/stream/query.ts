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
import { normalizeReadingStatus } from '../lib/bookwyrm-reading.js'
import { mergedCandidateSql, idArray, type LaneContext } from './lanes.js'
import { sanitizeHtml } from './sanitize-html.js'
import { toEmojis } from './emoji.js'
import { firstHttpUrl } from '../lib/ap-object.js'
import { publicOnlyCondition } from './visibility.js'
import { parseSources, AP_PLATFORMS, type ApPlatform, type Platform } from './sources.js'
import { osloDay, parsePartialDate } from './event-date.js'
import type { Facets } from './facets.js'
import { gardenEventAtOn } from './garden-date-sql.js'
import { journeySlug } from './journeys.js'
import { weatherSummary } from '../lib/weather-code.js'
import type {
  Attachment, Candidate, Entry, StreamPage, UndatedGardenNote,
  PostEntry, BookEntry, MarkEntry, ScrobbleDayEntry, TripEntry, GardenEntry, PostTrip,
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

/**
 * Seconds from an ISO-8601 duration (`PT16S`, `PT1M0S`, `PT1H2M3S`), or null.
 *
 * Only the time part is read. A day-or-longer video is not a thing Markus posts, and
 * a parser that guessed at `P1M` — a month, or a minute, depending on where it sits —
 * would be guessing about the one place the format is genuinely ambiguous.
 */
export function parseIsoDuration(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(raw.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null
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
      // A video's still frame. `icon` is where Rullen puts it; `preview` and `image`
      // are the other two spellings in the wild, and reading all three costs nothing.
      posterUrl: firstHttpUrl(att.icon) ?? firstHttpUrl(att.preview) ?? firstHttpUrl(att.image),
      durationSeconds: parseIsoDuration(att.duration),
    })
  }
  return out
}

/**
 * Thread parts, minus anything the root already shows.
 *
 * A server can federate one post two ways at once: a root carrying every attachment,
 * and one reply per attachment. Rullen does exactly that — a story Note holding all
 * its clips, plus a captionless clip Note for each — so the card rendered every clip
 * twice, the second time inside a thread block with no text in it at all.
 *
 * So: drop from a part any attachment the root already shows, then drop the part
 * outright if that leaves it with nothing to say. Keyed on the attachment URL rather
 * than written as a per-platform rule — the shape is not Rullen's alone, and a
 * platform check is a thing to remember to edit for the next server that does it.
 */
export function foldThread(
  parts: Array<{ content: string | null; url: string | null; attachments: unknown; tags?: unknown }>,
  rootAttachments: Attachment[],
): PostEntry['thread'] {
  const shown = new Set(rootAttachments.map((a) => a.url))
  const out: PostEntry['thread'] = []
  for (const r of parts) {
    const html = sanitizeHtml(r.content)
    const attachments = toAttachments(r.attachments).filter((a) => !shown.has(a.url))
    // A part that is only a duplicate is not a part. Its own text, if it has any,
    // still earns it a place — a caption is something Markus wrote.
    if (!html.trim() && attachments.length === 0) continue
    for (const a of attachments) shown.add(a.url)
    out.push({ html, attachments, originUrl: r.url, emojis: toEmojis(r.tags) })
  }
  return out
}

/** Hashtag names from the raw AP `tag` array. Mentions are ignored; emoji have their
 *  own reader in emoji.ts, which is what this used to drop on the floor. */
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
      // The origin's embeddable player, when it offers one. Read as a narrow JSON path
      // rather than by selecting `raw` — the whole object is large and this is the
      // only field of it the stream wants — and read from the payload rather than
      // built here, so no origin's URL shape gets hardcoded into this repo.
      previewHref: sql<string | null>`
        CASE WHEN ${objects.raw}->'preview'->>'mediaType' = 'text/html'
          THEN ${objects.raw}->'preview'->>'href' END`,
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
    inReplyTo: string | null; attachments: unknown; tags: unknown; publishedAt: Date | null
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
        attachments: objects.attachments, tags: objects.tags, publishedAt: objects.publishedAt,
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

  // The train each post was written on, from the derived join (ADR 0023). One
  // query for the whole page; the vast majority of posts have no row and stay
  // null. Keyed on the root's ap_id — a thread is one entry, so a continuation
  // written two stations later does not get its own line.
  const tripByApId = new Map<string, PostTrip>()
  if (rows.length > 0) {
    const tripRows = (await db.execute(sql`
      SELECT tp.object_ap_id, tp.relation,
             t.from_station, t.to_station, t.journey, t.operator, t.distance_km, t.night
      FROM trip_posts tp
      JOIN train_trips t ON t.id = tp.trip_id
      WHERE tp.object_ap_id = ANY(${idArray(rows.map((r) => r.apId))})`)) as unknown as
        Array<Record<string, unknown>>
    for (const t of tripRows) {
      const journey = t.journey == null ? null : String(t.journey)
      tripByApId.set(String(t.object_ap_id), {
        relation: String(t.relation) as PostTrip['relation'],
        fromStation: String(t.from_station),
        toStation: String(t.to_station),
        journey,
        journeySlug: journey ? journeySlug(journey) : null,
        operator: t.operator == null ? null : String(t.operator),
        distanceKm: t.distance_km == null ? null : Number(t.distance_km),
        night: Boolean(t.night),
      })
    }
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
    const attachments = toAttachments(row.attachments)
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
      attachments,
      hashtags: toHashtags(row.tags),
      emojis: toEmojis(row.tags),
      embedUrl: row.previewHref && /^https:\/\//i.test(row.previewHref) ? row.previewHref : null,
      thread: foldThread(threadOf(row.apId), attachments),
      trip: tripByApId.get(row.apId) ?? null,
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
      readingStatus: sql<string | null>`${objects.raw}->>'readingStatus'`,
      finishedDate: sql<string | null>`${objects.raw}->>'finishedDate'`,
      progress: sql<string | null>`${objects.raw}->>'progress'`,
      progressMode: sql<string | null>`${objects.raw}->>'progressMode'`,
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
    // A generated note has no body worth showing: its text is "Markus started
    // reading X", which is what the card already says in Norwegian. Everything else
    // is words Markus wrote, whatever kind the event was classified as — and that
    // is what puts his sentence on a start that arrived as a comment. Gating this
    // on `kind` instead of on the object is what used to lose it.
    const generated = row.apId.includes('/generatednote/')
    const status = normalizeReadingStatus(row.readingStatus)
    // Did this event close the book? A review does by BookWyrm's own reckoning, and
    // so does a `read`-shelved comment — neither of which produces a "finished
    // reading" note anywhere. Whether the card then says so is the view's call.
    const marksFinish = c.kind === 'book_finished' || c.kind === 'book_review' || status === 'read'
    const progress = row.progress ? Number(row.progress) : null
    const entry: BookEntry = {
      refId: c.refId,
      eventAt: c.eventAt,
      archivedAt: row.createdAt,
      source: 'bookwyrm',
      originUrl: row.url ?? row.apId,
      kind: c.kind as BookEntry['kind'],
      title: m?.title ?? null,
      subtitle: m?.subtitle ?? null,
      author: m?.author ?? null,
      coverUrl: m?.coverUrl ?? null,
      rating: ratingOf(row.rating),
      reviewTitle: row.reviewTitle,
      html: generated ? null : sanitizeHtml(row.content),
      quote: row.quote ? stripHtml(row.quote) : null,
      pages: m?.pages ?? null,
      pubYear: m?.pubYear ?? null,
      series: m?.series ?? null,
      bookUrl,
      contentWarning: row.summary || null,
      progress: progress != null && Number.isFinite(progress) ? progress : null,
      progressMode: row.progressMode,
      finishedAt: marksFinish ? (parsePartialDate(row.finishedDate) ?? c.eventAt) : null,
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

  // The weather at each origin on its departure day, in one query for the page.
  // Keyed by trip id; a trip whose station is not geocoded, or whose date the ERA5
  // archive does not reach, simply has no row.
  const weatherByTrip = new Map<string, string>()
  if (rows.length > 0) {
    const wx = (await db.execute(sql`
      SELECT t.id::text AS id, sw.weather_code, sw.temp_max_c
      FROM train_trips t
      JOIN stations s ON s.name = t.from_station
      JOIN station_weather sw ON sw.station_id = s.id AND sw.date = t.departure_local::date
      WHERE t.id = ANY(${idArray(rows.map((r) => r.id))}::uuid[])`)) as unknown as
        Array<{ id: string; weather_code: number | null; temp_max_c: string | null }>
    for (const w of wx) {
      const summary = weatherSummary(
        w.weather_code == null ? null : Number(w.weather_code),
        w.temp_max_c == null ? null : Number(w.temp_max_c),
      )
      if (summary) weatherByTrip.set(w.id, summary)
    }
  }

  for (const c of cands) {
    const row = rows.find((r) => r.id === refParts(c.refId).id)
    if (!row) continue
    const entry: TripEntry = {
      refId: c.refId, eventAt: c.eventAt, archivedAt: row.createdAt, source: 'tog',
      originUrl: null, kind: 'trip',
      fromStation: row.fromStation, toStation: row.toStation, journey: row.journey,
      operator: row.operator, distanceKm: row.distanceKm, mode: row.mode, night: row.night,
      weather: weatherByTrip.get(row.id) ?? null,
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
      // Read back through the same parser the lane's SQL mirrors, so the label
      // cannot disagree with the date the row was actually ordered by.
      dateSource: parsePartialDate(row.noteDate) ? 'frontmatter' : 'bookwyrm',
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

/**
 * Published garden notes with no date anywhere — not their own, and none
 * recoverable from a book they review.
 *
 * These cannot be in the stream: the ordering `(event_at DESC, ref_id DESC)` is
 * only a strict total order, and the keyset pagination over it only correct, if
 * every entry has a date. Rather than invent one — `fetched_at` would date a 2019
 * travel note to whenever the crawler first saw it — they are listed by name at the
 * foot of /kjelde/hage, so the whole garden stays reachable and linkable.
 *
 * Ordered by title so the list is stable between requests; it is rendered whole,
 * with no paging, and the garden is ~380 notes.
 */
export async function loadUndatedGardenNotes(): Promise<UndatedGardenNote[]> {
  const db = getDb()
  const rows = (await db.execute(sql`
    SELECT g.title, g.path
    FROM garden_notes g
    WHERE g.deleted_at IS NULL
      AND ${gardenEventAtOn('g')} IS NULL
      AND g.path <> '/'
    ORDER BY lower(g.title)`)) as unknown as Array<{ title: string; path: string }>
  return rows.map((r) => ({
    title: r.title,
    path: r.path,
    url: `https://markus.plus${r.path}`,
  }))
}

/**
 * Months that have at least one entry, newest first — for the sitemap.
 *
 * Truncated on Oslo's calendar, matching `archiveRange`. `date_trunc('month', ts)`
 * on a `timestamptz` uses the session's TimeZone, which is UTC in the container —
 * so without the explicit shift this listed a different set of months than the
 * pages it links to, and pointed at `/arkiv/YYYY/MM` for a month whose only entry
 * the page files under the next one.
 *
 * Future months are excluded for the same reason the lanes exclude future rows: the
 * viaduct.world import carries planned journeys, and a sitemap entry for a month
 * whose page is deliberately empty is a link to nothing.
 *
 * Known gap: `objects` is bucketed by `published_at`, while the reading lane dates
 * a book by its `startedDate`/`finishedDate`. A book finished in 2016 and posted in
 * 2024 therefore appears on `/arkiv/2016/…` without that month being listed here.
 * That makes the sitemap incomplete, never wrong, and the page is still reachable.
 */
export async function loadArchiveMonths(): Promise<string[]> {
  const db = getDb()
  const rows = (await db.execute(sql`
    SELECT to_char(m, 'YYYY-MM') AS month FROM (
      SELECT date_trunc('month', published_at AT TIME ZONE 'Europe/Oslo') AS m FROM objects
      WHERE published_at IS NOT NULL AND deleted_at IS NULL
        AND ${publicOnlyCondition(config.STREAM_INCLUDE_UNLISTED)}
      UNION
      SELECT date_trunc('month', coalesce(watched_at, published_at) AT TIME ZONE 'Europe/Oslo')
      FROM neodb_marks
      WHERE deleted_at IS NULL AND coalesce(watched_at, published_at) IS NOT NULL
      UNION
      SELECT date_trunc('month', departure_at AT TIME ZONE 'Europe/Oslo') FROM train_trips
    ) AS months
    WHERE m IS NOT NULL
      AND m AT TIME ZONE 'Europe/Oslo' <= now()
    ORDER BY m DESC
  `)) as unknown as Array<{ month: string }>
  return rows.map((r) => r.month)
}

/**
 * Hydrate a set of post ref ids into entries, newest first.
 *
 * For the journey pages, which select their posts by journey rather than by date
 * and so cannot go through the lane merge. Everything after the selection is
 * shared: the same hydrator, and therefore the same sanitising, thread folding and
 * content-warning handling the timeline gets.
 *
 * The candidate's `kind` and `source` are derived here exactly as postsLane
 * derives them — attachments decide photo/video, and the badge comes from
 * STREAM_SOURCES rather than from `actors.software`, which a server can set to
 * anything.
 */
export async function loadEntriesByRefIds(refIds: string[]): Promise<Entry[]> {
  if (refIds.length === 0) return []
  const ids = refIds
    .map((r) => refParts(r))
    .filter((p) => p.prefix === 'post')
    .map((p) => p.id)
  if (ids.length === 0) return []

  const actorIds = await resolveActorIds().catch((e) => {
    logger.error(e, 'Could not resolve stream sources; serving no journey entries')
    return EMPTY_ACTOR_IDS
  })
  const platformOf = new Map<string, ApPlatform>()
  for (const p of AP_PLATFORMS) for (const id of actorIds[p]) platformOf.set(id, p)

  const db = getDb()
  const rows = await db
    .select({
      id: objects.id, publishedAt: objects.publishedAt,
      attachments: objects.attachments, actorApId: objects.actorApId,
    })
    .from(objects)
    .where(and(inArray(objects.id, ids), isNull(objects.deletedAt)))

  const candidates: Candidate[] = []
  for (const r of rows) {
    if (!r.publishedAt) continue
    // Only accounts on the allowlist. A post can only have got here through the
    // journey query, which is already scoped — but a lane that re-derives the
    // scope is one that cannot be broken by a change to the other.
    const platform = platformOf.get(r.actorApId)
    if (!platform) continue
    const atts = toAttachments(r.attachments)
    const kind: Candidate['kind'] = atts.some((a) => a.mediaType?.startsWith('video/'))
      ? 'video'
      : atts.length > 0 ? 'photo' : 'post'
    candidates.push({
      eventAt: r.publishedAt,
      kind,
      refId: `post:${r.id}`,
      source: platform,
    })
  }

  const hydrated = await hydratePosts(candidates)
  return candidates
    .sort((a, b) => b.eventAt.getTime() - a.eventAt.getTime())
    .map((c) => hydrated.get(c.refId))
    .filter((e): e is Entry => e != null)
}
