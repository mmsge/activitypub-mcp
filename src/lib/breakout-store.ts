import { eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  config, getBreakoutActors, getBreakoutObjectTypes, getBreakoutWeights,
  type BreakoutWeights,
} from '../config.js'
import { getDb } from '../db/client.js'
import { actors, follows, postBreakoutState, serverConfig } from '../db/schema.js'
import { publicOnlyOn } from '../stream/visibility.js'
import {
  type BreakoutBaseline, type BreakoutPost, type BreakoutRung, type BreakoutState,
  type DigestMovement, type DigestRow,
} from './post-breakout.js'

/**
 * Database access for the breakout notifier. See decision record 0036.
 *
 * The one thing here that looks like it could be simplified back, and must not be:
 * every score is a `max()` over a post's WHOLE snapshot history, not the latest
 * snapshot. `get_actor_engagement_trends` uses `LEFT JOIN LATERAL … ORDER BY sampled_at
 * DESC LIMIT 1` for its series and is right to — it is charting what posts look like
 * now. This module is deciding whether something has ever been exceptional, and
 * engagement counts go DOWN. Reading the latest snapshot would let one un-favourite on
 * the record holder quietly lower the bar every future post is measured against, and
 * would let a post "beat a personal best" it never actually beat.
 *
 * The aggregate is served by the existing `engagement_snapshots_status_sampled_idx`
 * — an aggregate only needs the leading `status_ap_id` column — so no new index.
 */

const DIGEST_CURSOR_KEY = 'breakout_digest_last_sent_at'

/** The score expression, with the weights bound in. Shared by every query below so a
 *  weight change can never mean two different things in two places. */
function scoreExpr(w: BreakoutWeights): SQL {
  return sql`(es.favourites * ${w.favourites} + es.reblogs * ${w.reblogs} + es.replies * ${w.replies})`
}

/** The population filter: which of an actor's posts are judged at all.
 *
 *  Deliberately NOT filtered on visibility — Markus asked for every post the bot holds
 *  to count, so a followers-only post is in the population alongside the public ones.
 *  The consequence is recorded in record 0036: such a post is measured against a bar
 *  set mostly by public posts, so it will rarely clear one. `visibility` is carried
 *  through onto every row so that stays visible rather than mysterious. */
function populationWhere(actorApId: string): SQL {
  const types = getBreakoutObjectTypes()
  const conds: SQL[] = [
    sql`o.actor_ap_id = ${actorApId}`,
    sql`o.deleted_at IS NULL`,
    sql`o.published_at IS NOT NULL`,
    sql`o.type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})`,
  ]
  if (!config.BREAKOUT_INCLUDE_REPLIES) conds.push(sql`o.in_reply_to IS NULL`)
  return sql.join(conds, sql` AND `)
}

/** Every actor the notifier watches: BREAKOUT_ACTORS when set, otherwise every
 *  accepted follow — which for this server is exactly Markus' own accounts, since the
 *  inbox rejects everyone else. */
export async function resolveBreakoutActors(): Promise<Array<{ apId: string; label: string }>> {
  const db = getDb()
  const configured = getBreakoutActors()

  const rows = await db
    .select({ apId: follows.actorApId })
    .from(follows)
    .where(eq(follows.status, 'accepted'))

  let apIds = rows.map(r => r.apId)
  if (configured.length) {
    // Configured entries may be handles or actor URLs; match either form.
    const urls = new Set(configured.filter(c => c.startsWith('http')))
    const handles = new Set(
      configured.filter(c => !c.startsWith('http')).map(h => h.replace(/^@/, '').toLowerCase()),
    )
    const named = handles.size
      ? await db.select({ apId: actors.apId, handle: actors.handle }).from(actors)
      : []
    for (const a of named) {
      if (a.handle && handles.has(a.handle.replace(/^@/, '').toLowerCase())) urls.add(a.apId)
    }
    apIds = apIds.filter(id => urls.has(id))
  }
  if (apIds.length === 0) return []

  const labelled = await db
    .select({ apId: actors.apId, handle: actors.handle })
    .from(actors)
    .where(inArray(actors.apId, apIds))
  const byId = new Map(labelled.map(a => [a.apId, a.handle]))

  return apIds.map(apId => {
    const handle = byId.get(apId)
    return { apId, label: handle ? (handle.startsWith('@') ? handle : `@${handle}`) : apId }
  })
}

/**
 * The p90/p99 bar, the all-time record and the runner-up for one actor.
 *
 * Percentiles come from `percentile_cont` in SQL, matching
 * `get_actor_engagement_trends` — pulling every post's snapshot history into TS to
 * sort it there would be unbounded, and Postgres has the set materialised already.
 *
 * The percentiles are windowed; the record is NOT. A personal best is a personal best,
 * however long ago it was set. `second_best` exists so that a post which already holds
 * the record is never asked to beat itself — see `breakoutThresholds`.
 */
export async function loadBreakoutBaseline(
  actorApId: string,
  label: string,
): Promise<BreakoutBaseline> {
  const db = getDb()
  const w = getBreakoutWeights()
  const days = config.BREAKOUT_BASELINE_DAYS

  const [row] = [...await db.execute<{
    n: string | number
    median: string | number | null
    p90: string | number | null
    p99: string | number | null
    best: string | number | null
    best_ap_id: string | null
    second_best: string | number | null
  }>(sql`
    WITH scored AS (
      SELECT o.ap_id,
             o.published_at,
             (SELECT max(${scoreExpr(w)})
                FROM engagement_snapshots es
               WHERE es.status_ap_id = o.ap_id)::int AS score
        FROM objects o
       WHERE ${populationWhere(actorApId)}
    ),
    contributors AS (SELECT * FROM scored WHERE score IS NOT NULL),
    windowed AS (
      SELECT * FROM contributors
       WHERE published_at >= now() - (${String(days)} || ' days')::interval
    ),
    ranked AS (
      SELECT ap_id, score, row_number() OVER (ORDER BY score DESC, ap_id) AS rn
        FROM contributors
    )
    SELECT (SELECT count(*) FROM windowed) AS n,
           (SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY score) FROM windowed) AS median,
           (SELECT percentile_cont(0.90) WITHIN GROUP (ORDER BY score) FROM windowed) AS p90,
           (SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY score) FROM windowed) AS p99,
           (SELECT score  FROM ranked WHERE rn = 1) AS best,
           (SELECT ap_id  FROM ranked WHERE rn = 1) AS best_ap_id,
           (SELECT score  FROM ranked WHERE rn = 2) AS second_best
  `)]

  const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v))

  return {
    actorApId,
    actor: label,
    n: n(row?.n),
    windowDays: days,
    median: n(row?.median),
    p90: n(row?.p90),
    p99: n(row?.p99),
    best: n(row?.best),
    bestApId: row?.best_ap_id ?? null,
    secondBest: n(row?.second_best),
  }
}

interface CandidateOpts {
  actorApId: string
  /** Only posts published within this many days. */
  days: number
  /** Restrict to these AP ids (the fast lane passes the set it just sampled). */
  apIds?: string[]
  limit?: number
  /**
   * Restrict to posts the origin marked public. Off for the jobs (they alert Markus
   * about his own archive) and for MCP; forced on for REST, which feeds public pages.
   * See ADR 0026.
   */
  publicOnly?: boolean
}

/**
 * Candidate posts with both their peak score and their latest counts.
 *
 * Posts whose `rung` is already `'best'` are skipped: the ladder is spent, so there is
 * nothing left that could fire and re-reading them buys nothing.
 */
export async function loadBreakoutCandidates(opts: CandidateOpts): Promise<BreakoutPost[]> {
  const db = getDb()
  const w = getBreakoutWeights()

  const conds: SQL[] = [populationWhere(opts.actorApId)]
  conds.push(sql`o.published_at >= now() - (${String(opts.days)} || ' days')::interval`)
  if (opts.apIds) {
    if (opts.apIds.length === 0) return []
    conds.push(sql`o.ap_id IN (${sql.join(opts.apIds.map(i => sql`${i}`), sql`, `)})`)
  }
  if (opts.publicOnly) conds.push(publicOnlyOn('o', false))

  const rows = [...await db.execute<{
    ap_id: string; actor_ap_id: string; url: string | null
    published_at: string | null; content_text: string | null; visibility: string | null
    favourites: number | string; reblogs: number | string; replies: number | string
    peak: number | string; score: number | string
  }>(sql`
    SELECT o.ap_id, o.actor_ap_id, o.url, o.published_at, o.content_text, o.visibility,
           latest.favourites, latest.reblogs, latest.replies,
           peak.peak::int AS peak,
           (latest.favourites * ${w.favourites}
            + latest.reblogs * ${w.reblogs}
            + latest.replies * ${w.replies})::int AS score
      FROM objects o
      LEFT JOIN post_breakout_state st ON st.status_ap_id = o.ap_id
      JOIN LATERAL (
        SELECT es.favourites, es.reblogs, es.replies
          FROM engagement_snapshots es
         WHERE es.status_ap_id = o.ap_id
         ORDER BY es.sampled_at DESC
         LIMIT 1
      ) latest ON true
      JOIN LATERAL (
        SELECT max(${scoreExpr(w)}) AS peak
          FROM engagement_snapshots es
         WHERE es.status_ap_id = o.ap_id
      ) peak ON true
     WHERE ${sql.join(conds, sql` AND `)}
       AND (st.rung IS NULL OR st.rung <> 'best')
     ORDER BY o.published_at DESC
     LIMIT ${opts.limit ?? 500}
  `)]

  return rows.map(r => ({
    apId: r.ap_id,
    actorApId: r.actor_ap_id,
    url: r.url,
    publishedAt: r.published_at ? new Date(r.published_at) : null,
    text: r.content_text,
    visibility: r.visibility,
    favourites: Number(r.favourites),
    reblogs: Number(r.reblogs),
    replies: Number(r.replies),
    peak: Number(r.peak),
    score: Number(r.score),
  }))
}

/**
 * AP ids of an actor's young posts, for the fast lane to re-sample.
 *
 * Unlike `loadBreakoutCandidates` this does NOT require an existing snapshot — a post
 * published five minutes ago may never have been sampled, and it is exactly the one
 * worth looking at. Posts already at the top rung are excluded: nothing more can fire.
 */
export async function loadFastLaneTargets(opts: {
  actorApId: string
  hours: number
  limit: number
}): Promise<string[]> {
  const db = getDb()
  const rows = [...await db.execute<{ ap_id: string }>(sql`
    SELECT o.ap_id
      FROM objects o
      LEFT JOIN post_breakout_state st ON st.status_ap_id = o.ap_id
     WHERE ${populationWhere(opts.actorApId)}
       AND o.published_at >= now() - (${String(opts.hours)} || ' hours')::interval
       AND (st.rung IS NULL OR st.rung <> 'best')
     ORDER BY o.published_at DESC
     LIMIT ${opts.limit}
  `)]
  return rows.map(r => r.ap_id)
}

export async function loadBreakoutStates(
  apIds: string[],
): Promise<Map<string, BreakoutState>> {
  if (apIds.length === 0) return new Map()
  const db = getDb()
  const rows = await db
    .select()
    .from(postBreakoutState)
    .where(inArray(postBreakoutState.statusApId, apIds))

  return new Map(rows.map(r => [r.statusApId, {
    score: r.score,
    peakScore: r.peakScore,
    rung: (r.rung as BreakoutRung | null) ?? null,
    rungScore: r.rungScore,
    p90At: r.p90At,
    p99At: r.p99At,
    bestAt: r.bestAt,
    weightsKey: r.weightsKey,
  }]))
}

export async function saveBreakoutState(
  statusApId: string,
  actorApId: string,
  s: BreakoutState,
): Promise<void> {
  const db = getDb()
  const values = {
    statusApId,
    actorApId,
    score: s.score,
    peakScore: s.peakScore,
    rung: s.rung,
    rungScore: s.rungScore,
    p90At: s.p90At,
    p99At: s.p99At,
    bestAt: s.bestAt,
    weightsKey: s.weightsKey,
  }
  await db
    .insert(postBreakoutState)
    .values(values)
    .onConflictDoUpdate({
      target: postBreakoutState.statusApId,
      set: { ...values, updatedAt: new Date() },
    })
}

export interface RecentBreakout {
  statusApId: string
  actorApId: string
  actor: string
  rung: BreakoutRung
  firedAt: Date
  score: number
  peakScore: number
  currentScore: number
  visibility: string | null
  text: string | null
  url: string | null
}

/**
 * Breakouts actually ANNOUNCED in the last `days`, newest first.
 *
 * Reads the three *_at stamps, never `rung`: a rung pre-marked at seed time was never
 * announced, and listing it as a breakout would report the day the feature was switched
 * on as the day everything happened.
 */
export async function loadRecentBreakouts(opts: {
  days: number
  limit: number
  actorApId?: string
  publicOnly?: boolean
}): Promise<RecentBreakout[]> {
  const db = getDb()
  const conds: SQL[] = [
    sql`x.fired_at >= now() - (${String(opts.days)} || ' days')::interval`,
  ]
  if (opts.actorApId) conds.push(sql`st.actor_ap_id = ${opts.actorApId}`)
  // A post with no `objects` row left (deleted and pruned) has no visibility to
  // check, so the public-only scope drops it rather than guessing. ADR 0017 fails
  // closed and so does this.
  if (opts.publicOnly) conds.push(publicOnlyOn('o', false))

  const rows = [...await db.execute<{
    status_ap_id: string; actor_ap_id: string; actor: string | null
    rung: string; fired_at: string
    rung_score: number | string | null; peak_score: number | string; score: number | string
    visibility: string | null; content_text: string | null; url: string | null
  }>(sql`
    SELECT st.status_ap_id, st.actor_ap_id,
           coalesce(a.handle, st.actor_ap_id) AS actor,
           x.rung, x.fired_at,
           st.rung_score, st.peak_score, st.score,
           o.visibility, o.content_text, o.url
      FROM post_breakout_state st
      CROSS JOIN LATERAL (
        SELECT r.rung, r.fired_at
          FROM (VALUES ('best', st.best_at), ('p99', st.p99_at), ('p90', st.p90_at))
               AS r(rung, fired_at)
         WHERE r.fired_at IS NOT NULL
         ORDER BY r.fired_at DESC
         LIMIT 1
      ) x
      LEFT JOIN objects o ON o.ap_id = st.status_ap_id
      LEFT JOIN actors  a ON a.ap_id = st.actor_ap_id
     WHERE ${sql.join(conds, sql` AND `)}
     ORDER BY x.fired_at DESC
     LIMIT ${opts.limit}
  `)]

  return rows.map(r => ({
    statusApId: r.status_ap_id,
    actorApId: r.actor_ap_id,
    actor: r.actor ?? r.actor_ap_id,
    rung: r.rung as BreakoutRung,
    firedAt: new Date(r.fired_at),
    score: Number(r.rung_score ?? r.peak_score),
    peakScore: Number(r.peak_score),
    currentScore: Number(r.score),
    visibility: r.visibility,
    text: r.content_text,
    url: r.url,
  }))
}

// ── The digest ─────────────────────────────────────────────────────────────────

/** Rungs actually ANNOUNCED since `since`. Reads the three *_at stamps rather than
 *  `rung`, which is the whole point of storing them separately: a rung pre-marked at
 *  seed time was never announced and must not appear in a summary of the day. */
export async function loadDigestRows(since: Date): Promise<DigestRow[]> {
  const db = getDb()
  const rows = [...await db.execute<{
    actor: string | null; actor_ap_id: string; rung: string
    fired_at: string; score: number | string
    content_text: string | null; url: string | null
  }>(sql`
    SELECT coalesce(a.handle, st.actor_ap_id) AS actor,
           st.actor_ap_id,
           x.rung, x.fired_at,
           st.rung_score AS score,
           o.content_text, o.url
      FROM post_breakout_state st
      CROSS JOIN LATERAL (
        SELECT r.rung, r.fired_at
          FROM (VALUES ('best', st.best_at), ('p99', st.p99_at), ('p90', st.p90_at))
               AS r(rung, fired_at)
         WHERE r.fired_at IS NOT NULL AND r.fired_at >= ${since.toISOString()}::timestamptz
         ORDER BY r.fired_at DESC
         LIMIT 1
      ) x
      LEFT JOIN objects o ON o.ap_id = st.status_ap_id
      LEFT JOIN actors  a ON a.ap_id = st.actor_ap_id
     ORDER BY x.fired_at ASC
  `)]

  return rows.map(r => ({
    actor: r.actor ?? r.actor_ap_id,
    rung: r.rung as BreakoutRung,
    firedAt: new Date(r.fired_at),
    score: Number(r.score ?? 0),
    text: r.content_text,
    url: r.url,
  }))
}

/**
 * Net engagement gained across every tracked post since `since`.
 *
 * This is the part a per-post push can never tell him: what came in across everything,
 * including the posts that never crossed a rung. Computed as the latest snapshot minus
 * the last snapshot taken BEFORE the window, per post, summed — so a post that gained
 * nothing contributes nothing rather than its whole standing count.
 *
 * A post with no earlier snapshot is the interesting case, and it splits two ways:
 *
 *  - **Published inside the window** — everything it has was genuinely gained here, so
 *    it counts in full. A post written this morning with 90 favourites did earn 90
 *    favourites today, and reporting 0 would make the digest silent about exactly the
 *    day's biggest news.
 *  - **Published before the window** — it has only just started being sampled (an
 *    outbox backfill, or the post ageing into the sampler's reach). Its standing count
 *    was earned over weeks and dumping it into "today" would be a straight lie, so it
 *    contributes 0 until there is a second snapshot to difference against.
 */
export async function loadDigestMovement(
  actorApIds: string[],
  since: Date,
): Promise<DigestMovement> {
  if (actorApIds.length === 0) return { favourites: 0, reblogs: 0, replies: 0 }
  const db = getDb()

  const [row] = [...await db.execute<{
    favourites: string | number | null
    reblogs: string | number | null
    replies: string | number | null
  }>(sql`
    WITH tracked AS (
      SELECT o.ap_id,
             -- Whether the post is itself new in this window; decides how one with no
             -- earlier snapshot is treated, below.
             (o.published_at >= ${since.toISOString()}::timestamptz) AS is_new
        FROM objects o
       WHERE o.actor_ap_id IN (${sql.join(actorApIds.map(i => sql`${i}`), sql`, `)})
         AND o.deleted_at IS NULL
    ),
    now_counts AS (
      SELECT t.ap_id, t.is_new, s.favourites, s.reblogs, s.replies
        FROM tracked t
        JOIN LATERAL (
          SELECT favourites, reblogs, replies FROM engagement_snapshots es
           WHERE es.status_ap_id = t.ap_id
           ORDER BY es.sampled_at DESC LIMIT 1
        ) s ON true
    ),
    then_counts AS (
      SELECT t.ap_id, s.favourites, s.reblogs, s.replies
        FROM tracked t
        JOIN LATERAL (
          SELECT favourites, reblogs, replies FROM engagement_snapshots es
           WHERE es.status_ap_id = t.ap_id
             AND es.sampled_at < ${since.toISOString()}::timestamptz
           ORDER BY es.sampled_at DESC LIMIT 1
        ) s ON true
    )
    -- No earlier snapshot ⇒ the baseline is 0 for a post published in this window (it
    -- earned the lot here) and the post's own current count for an older one (so it
    -- differences to zero and contributes nothing until there is real movement to read).
    SELECT coalesce(sum(n.favourites - coalesce(p.favourites, CASE WHEN n.is_new THEN 0 ELSE n.favourites END)), 0) AS favourites,
           coalesce(sum(n.reblogs    - coalesce(p.reblogs,    CASE WHEN n.is_new THEN 0 ELSE n.reblogs    END)), 0) AS reblogs,
           coalesce(sum(n.replies    - coalesce(p.replies,    CASE WHEN n.is_new THEN 0 ELSE n.replies    END)), 0) AS replies
      FROM now_counts n
      LEFT JOIN then_counts p ON p.ap_id = n.ap_id
  `)]

  // Movement is reported as gains. A net loss over the day (more un-favourites than
  // favourites) is real but is not something to push about, and a negative "+ -3
  // hjarte" line reads as a bug.
  const gain = (v: string | number | null | undefined) => Math.max(0, Number(v ?? 0))
  return {
    favourites: gain(row?.favourites),
    reblogs: gain(row?.reblogs),
    replies: gain(row?.replies),
  }
}

/** The digest cursor lives in `server_config` — one timestamp does not deserve a
 *  table, and that table is already the established marker store. */
export async function readDigestCursor(): Promise<Date | null> {
  const db = getDb()
  const [row] = await db
    .select({ value: serverConfig.value })
    .from(serverConfig)
    .where(eq(serverConfig.key, DIGEST_CURSOR_KEY))
    .limit(1)
  if (!row?.value) return null
  const d = new Date(row.value)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function writeDigestCursor(at: Date): Promise<void> {
  const db = getDb()
  await db
    .insert(serverConfig)
    .values({ key: DIGEST_CURSOR_KEY, value: at.toISOString() })
    .onConflictDoUpdate({
      target: serverConfig.key,
      set: { value: at.toISOString(), updatedAt: new Date() },
    })
}
