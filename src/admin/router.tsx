/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth } from './middleware.js'
import { verifyAdminPassword, createSession, deleteSession } from './auth.js'
import { getDb } from '../db/client.js'
import { activities, objects, follows, activityLog, linkedinPosts, scrobbles, trainTrips } from '../db/schema.js'
import { and, desc, eq, gt, gte, count, isNull, isNotNull, or } from 'drizzle-orm'
import { LoginPage } from './views/login.js'
import { DashboardPage } from './views/dashboard.js'
import { LogsPage, LogRows, logFilterOf } from './views/logs.js'
import { pinStationToWaypoint } from '../jobs/pin-station.js'
import { config } from '../config.js'
import {
  ImportListPage,
  ImportKindPage,
  ImportResultPage,
  TripImportResultPage,
  TripPruneResultPage,
  YoutubeImportResultPage,
  StorygraphImportResultPage,
  TripTrackImportResultPage,
} from './views/import.js'
import { mediaRouter } from './media-router.js'
import { importKind } from './import-kinds.js'
import { recordImportRun, lastImportRuns } from './import-runs.js'
import { categoryRouter, linkedinStaleMs } from './category-router.js'
import { categoryHref, redirectFor } from './categories.js'
import { mediaCounts } from './media-query.js'
import { parseYoutubeWatchHistory } from '../lib/parse-youtube-takeout.js'
import { parseStorygraphCsv } from '../lib/parse-storygraph-csv.js'
import { importStorygraphReads } from '../jobs/import-storygraph-reads.js'
import { importYoutubeWatches } from '../jobs/import-youtube-watches.js'
import { parseViaductGpx } from '../lib/parse-viaduct-gpx.js'
import { importTripTracks } from '../jobs/import-trip-tracks.js'
import {
  parseMastodonArchive,
  crawlOutbox,
  processActivityBatch,
  ensureActor,
  reprocessActivitiesByType,
  importTrainTrips,
  importLinkedinMetrics,
  BARE_OBJECT_TYPES,
} from './import.js'
import { repairNeodbIngest } from '../jobs/repair-neodb-ingest.js'
import { parseLinkedinExport } from '../lib/parse-linkedin-export.js'
import { deriveTokenStatus, getSourceHealth, LINKEDIN_SOURCE } from '../lib/source-health.js'
import { parseTrainTripsCsv } from '../lib/parse-trips-csv.js'
import { notifyTripsChanged } from '../lib/trip-webhook.js'
import { notifyMsgeChanged } from '../lib/msge-webhook.js'
import { runConvergenceWatch } from '../jobs/convergence.js'
import { applyTripPrune } from './prune-trips.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'

const app = new Hono()

// Login
app.get('/login', (c) => c.html(<LoginPage />))

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const password = body.password as string
  if (await verifyAdminPassword(password)) {
    const token = await createSession()
    setCookie(c, 'session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 86400,
      path: '/',
    })
    return c.redirect('/admin')
  }
  return c.html(<LoginPage error="Feil passord." />)
})

app.get('/logout', async (c) => {
  const token = getCookie(c, 'session') ?? ''
  await deleteSession(token)
  deleteCookie(c, 'session')
  return c.redirect('/admin/login')
})

// Protected routes
app.use('/*', requireAuth)

// The pages that became category tabs answer 301 with their filters kept (ADR 0073).
// After the session gate, so a logged-out browser gets the login redirect, which it
// does not cache, rather than a permanent one.
app.on('GET', ['/media', '/media/', '/activities', '/objects', '/follows', '/threads', '/breakouts',
  '/visibility', '/stations', '/linkedin', '/tools'], (c) => {
  const url = new URL(c.req.url)
  const to = redirectFor(`/admin${url.pathname.replace(/^\/admin/, '')}`, url.searchParams)
  return to ? c.redirect(to, 301) : c.notFound()
})

// Oversikt
app.get('/', async (c) => {
  const db = getDb()
  const now = new Date()
  const day24 = new Date(now.getTime() - 86_400_000)
  const day7 = new Date(now.getTime() - 7 * 86_400_000)

  const [
    [{ cnt: activities24h }],
    [{ cnt: activities7d }],
    [{ cnt: totalObjects }],
    pendingFollows,
    recentActs,
    [{ cnt: delivErrors24h }],
    media,
    [{ cnt: scrobbleCount }],
    [{ cnt: tripCount }],
    [{ cnt: liPosts }],
    liHealth,
  ] = await Promise.all([
    db.select({ cnt: count() }).from(activities).where(gt(activities.receivedAt, day24)),
    db.select({ cnt: count() }).from(activities).where(gt(activities.receivedAt, day7)),
    db.select({ cnt: count() }).from(objects).where(isNull(objects.deletedAt)),
    db.select({ actorApId: follows.actorApId }).from(follows)
      .where(eq(follows.status, 'pending')).orderBy(follows.followedAt),
    db.select().from(activities).orderBy(desc(activities.receivedAt)).limit(3),
    // The last 24 hours only: an all-time count never goes back to zero, so a card
    // built on it could never be cleared.
    db.select({ cnt: count() }).from(activityLog).where(and(
      eq(activityLog.direction, 'outbound'),
      gte(activityLog.responseStatus, 400),
      gt(activityLog.createdAt, day24),
    )),
    mediaCounts(),
    db.select({ cnt: count() }).from(scrobbles),
    db.select({ cnt: count() }).from(trainTrips),
    db.select({ cnt: count() }).from(linkedinPosts),
    getSourceHealth(LINKEDIN_SOURCE),
  ])

  return c.html(
    <DashboardPage data={{
      activitiesLast24h: Number(activities24h),
      activitiesLast7d: Number(activities7d),
      recentActivities: recentActs,
      totalObjects: Number(totalObjects),
      media,
      scrobbles: Number(scrobbleCount),
      trips: Number(tripCount),
      linkedinPosts: Number(liPosts),
      linkedinStatus: deriveTokenStatus(liHealth, linkedinStaleMs(), now),
      linkedinLastSuccessAt: liHealth?.lastSuccessAt ?? null,
      linkedinLastHttpStatus: liHealth?.lastHttpStatus ?? null,
      deliveryErrors24h: Number(delivErrors24h),
      failedEnrichment: media.failedEnrichment,
      pendingFollowActors: pendingFollows.map((f) => f.actorApId),
    }} />
  )
})


// The pin. The posted coordinates must be one of viaduct's own waypoints for that name,
// which pinStationToWaypoint checks, so this form cannot place a station anywhere else.
app.post('/stations/pin', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
  const body = await c.req.parseBody()
  const name = typeof body['name'] === 'string' ? body['name'] : ''
  const latitude = Number(body['latitude'])
  const longitude = Number(body['longitude'])
  const back = (key: 'notice' | 'error', message: string) =>
    c.redirect(categoryHref('reiser', 'stasjonar', { [key]: message }))
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return back('error', 'Festinga mangla stasjonen eller koordinatane')
  }
  const result = await pinStationToWaypoint(name, latitude, longitude)
  if (!result.ok) return back('error', result.reason)
  const moved = result.movedKm == null ? 'plassert' : `flytta ${result.movedKm} km`
  const extra = result.countryCleared
    ? `; landet tømt, ${result.weatherDropped} vêrdagar sletta og blir henta på nytt`
    : ''
  return back('notice', `${result.name} festa til viaduct-posisjonen (${moved}${extra}).`)
})

// Logs. The page and its 10s poll run the same query, so it lives in one place.
const LOGS_LIMIT = 50

async function queryLogs(c: Context) {
  const db = getDb()
  const page = Math.max(0, Number(c.req.query('page') ?? '0') || 0)
  const filter = logFilterOf({ f: c.req.query('f'), direction: c.req.query('direction'), sigValid: c.req.query('sigValid') })
  const actor = c.req.query('actor') || undefined

  const conditions = []
  if (filter === 'inn') conditions.push(eq(activityLog.direction, 'inbound'))
  if (filter === 'ut') conditions.push(eq(activityLog.direction, 'outbound'))
  if (filter === 'ugyldig') conditions.push(eq(activityLog.signatureValid, false))
  // An error is a status of 400 or more, or a request that never got one.
  if (filter === 'feil') conditions.push(or(gte(activityLog.responseStatus, 400), isNotNull(activityLog.error))!)
  if (actor) conditions.push(eq(activityLog.actorApId, actor))

  const rows = await db.select().from(activityLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(LOGS_LIMIT + 1)
    .offset(page * LOGS_LIMIT)

  return {
    logs: rows.slice(0, LOGS_LIMIT),
    page,
    hasMore: rows.length > LOGS_LIMIT,
    filter,
    actor,
  }
}

app.get('/logs', async (c) => c.html(<LogsPage {...(await queryLogs(c))} />))

// The tbody fragment the page polls every 10s. Without this route the poll was a 404
// every 10 seconds and the "auto-refreshes" label was simply untrue.
app.get('/logs/rows', async (c) => {
  const { logs } = await queryLogs(c)
  return c.html(<LogRows logs={logs} />)
})

// Media actions (re-enrich, hide, sync). Mounted below `app.use('/*', requireAuth)`
// above, so they inherit the session gate. The pages are under /k now.
app.route('/media', mediaRouter)

// Category pages (ADR 0073).
app.route('/k', categoryRouter)


// Import (ADR 0073, phase 3): the list, one page per import, and the POSTs below.
app.get('/import', async (c) => c.html(<ImportListPage runs={await lastImportRuns()} />))

/** A refused import: recorded as a failed run, and the form shown again with the reason. */
async function fail(c: Context, kind: string, error: string) {
  await recordImportRun(kind, { ok: false, error })
  const k = importKind(kind)
  return k ? c.html(<ImportKindPage kind={k} error={error} />, 422) : c.text(error, 422)
}

app.post(
  '/import/archive',
  bodyLimit({ maxSize: 50 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['archive']
    if (!file || typeof file === 'string') {
      return fail(c, 'archive', "Inga fil lasta opp")
    }
    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return fail(c, 'archive', "Kunne ikkje lese fila")
    }

    let items: unknown[]
    try {
      items = parseMastodonArchive(text)
    } catch (e) {
      return fail(c, 'archive', String(e))
    }

    const firstActivity = items[0] as Record<string, unknown> | undefined
    const actorUrl =
      firstActivity && typeof firstActivity.actor === 'string'
        ? firstActivity.actor
        : null
    if (!actorUrl) {
      return fail(c, 'archive', "Fann ikkje aktøren i arkivet")
    }

    try {
      await ensureActor(actorUrl)
    } catch (e) {
      return fail(c, 'archive', `Kunne ikkje hente aktøren: ${e}`)
    }

    const result = await processActivityBatch(items, (n) => {
      logger.info({ n, total: items.length }, 'Archive import progress')
    })

    const params = new URLSearchParams({
      actor: actorUrl,
      total: String(result.total),
      imported: String(result.imported),
      skipped: String(result.skipped),
      errorCount: String(result.errors.length),
    })
    params.set('kind', 'archive')
    await recordImportRun('archive', { ok: true, summary: `${params.get('imported')} importerte, ${params.get('skipped')} fanst frå før` })
    return c.redirect(`/admin/import/result?${params}`)
  },
)

app.post(
  '/import/trips',
  bodyLimit({ maxSize: 25 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return fail(c, 'trips', "Inga fil lasta opp")
    }
    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return fail(c, 'trips', "Kunne ikkje lese fila")
    }

    let rows
    try {
      rows = parseTrainTripsCsv(text)
    } catch (e) {
      return fail(c, 'trips', String(e))
    }

    const result = await importTrainTrips(rows)
    logger.info(
      {
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
        pruneCandidates: result.prune.candidates.length,
        inWindow: result.prune.inWindow,
        refused: result.prune.refusal !== null,
      },
      'Train trips import complete',
    )

    // Wake bartenderen, which tends the "Neste togtur" field on the fediverse
    // profile from exactly these rows. Without this it would pick the change up
    // within four hours, which is its backstop rather than its mechanism — and a
    // leg is usually entered *because* it is imminent. Only when something
    // actually changed; never throws, so a failure here cannot fail the import.
    //
    // Inserts and updates only. This run deleted nothing — it merely reported what
    // it would delete — and waking a service to recompute an unchanged answer is
    // exactly the noise the fire-on-change rule exists to avoid (ADR 0053).
    await notifyTripsChanged(result.inserted + result.updated)

    // And msge.no, whose /tog, /meir and both train counters are rebuilt by pollers
    // that would otherwise not look again for six hours. Same rules: only when
    // something actually changed, and never fatal to the import.
    await notifyMsgeChanged('tog', result.inserted + result.updated)

    // Re-settle the convergence watcher, with a FULL recompute rather than the tick's
    // resume-from-watermark. This is the one path that can change the past: an export
    // inserts or corrects a leg at any date, and every kilometre it adds shifts the
    // running difference for every event after it. A crossing that only exists now
    // that this leg does is announced with the date it actually happened.
    //
    // Its own try/catch, and after both webhooks: the import is the durable thing, and
    // a watcher that throws must not turn a successful import into an error page.
    try {
      await runConvergenceWatch({ recompute: true })
    } catch (e) {
      logger.error(e, 'Convergence watch failed after trip import')
    }

    // Rendered rather than redirected, unlike the other importers: the list of trips
    // this export no longer contains is the substance of the report and will not
    // survive a query string. Re-POSTing on refresh is harmless — the import is
    // idempotent, and the page deletes nothing on its own.
    await recordImportRun('trips', { ok: true, summary: `${result.inserted} nye, ${result.updated} oppdaterte, ${result.prune.candidates.length} manglar i fila` })
    return c.html(<TripImportResultPage result={result} />)
  },
)

// Step two, and the only route that can delete a trip. The ids come from the result
// page the admin has just read; every guarantee that page made — the export's range,
// the threshold, and that nothing has been stored since the plan was drawn — is
// re-established here against the live database, so the posted list can only ever
// narrow what goes. See decision record 0054.
app.post(
  '/import/trips/prune',
  bodyLimit({ maxSize: 256 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body['trip']
    const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => UUID.test(v))

    const window = {
      from: parseInstant(body['window_from']),
      to: parseInstant(body['window_to']),
    }
    const derivedAt = parseInstant(body['derived_at'])
    if (!window.from || !window.to || !derivedAt) {
      return c.html(<ImportKindPage kind={importKind('trips')!} error="Fjerninga mangla tidsrommet til eksporten" />, 422)
    }
    if (ids.length === 0) {
      return c.html(<ImportKindPage kind={importKind('trips')!} error="Fjerninga nemnde ingen turar" />, 422)
    }

    const result = await applyTripPrune({
      ids,
      window: { from: window.from, to: window.to },
      derivedAt,
    })

    // A prune is a change like any other, and the one that matters most to the
    // receiver: a phantom future leg is exactly what it would be advertising as
    // "Neste togtur".
    await notifyTripsChanged(result.deleted)

    // And msge.no, for the same reason and then some: a pruned future leg is what
    // /tog and the "Akkurat no" countdown are advertising as the next train, and
    // both re-derive `upcoming` from a schedule this deletion just invalidated.
    // Left alone it would count down to a train that no longer exists for six hours.
    await notifyMsgeChanged('tog', result.deleted)

    // A deletion rewrites the past exactly as an insertion does — the kilometres those
    // legs contributed are gone from every total after them, so a crossing derived from
    // them is no longer true. Full recompute, same reasoning as the import above.
    try {
      await runConvergenceWatch({ recompute: true })
    } catch (e) {
      logger.error(e, 'Convergence watch failed after trip prune')
    }

    return c.html(<TripPruneResultPage result={result} />)
  },
)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An ISO instant from a form field, or null. Never a partial or shifted date. */
function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// viaduct.world GPX export → the line each trip drew, and viaduct's station waypoints.
// Its own upload, separate from the CSV: the two are different files, and neither import
// writes the other's tables. The GPX is the complete set, so this one replaces rather
// than merges. No webhook: nothing downstream reads track geometry yet. See ADR 0070.
app.post(
  '/import/trip-tracks',
  bodyLimit({ maxSize: 50 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return fail(c, 'trip-tracks', "Inga fil lasta opp")
    }
    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return fail(c, 'trip-tracks', "Kunne ikkje lese fila")
    }

    let report
    try {
      report = await importTripTracks(parseViaductGpx(text))
    } catch (e) {
      return fail(c, 'trip-tracks', e instanceof Error ? e.message : String(e))
    }
    await recordImportRun('trip-tracks', { ok: true, summary: `${report.tracksInFile} ruter, ${report.unmatched.length} utan tur` })
    return c.html(<TripTrackImportResultPage report={report} />)
  },
)

// StoryGraph library export → read dates that fill BookWyrm's gaps. An upload for the
// same reason as the others here: StoryGraph has no API, and sidetal's scrape covers the
// reading journal, not the library. Rendered rather than redirected, like the trips
// import: the conflicts and unmatched books are the report. See ADR 0063.
app.post(
  '/import/storygraph',
  bodyLimit({ maxSize: 25 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return fail(c, 'storygraph', "Inga fil lasta opp")
    }
    const actorInput = typeof body['actor'] === 'string' ? body['actor'].trim() : ''
    if (!actorInput) {
      return fail(c, 'storygraph', "Skriv kva BookWyrm-konto lesingane høyrer til")
    }

    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return fail(c, 'storygraph', "Kunne ikkje lese fila")
    }

    let rows
    try {
      rows = parseStorygraphCsv(text)
    } catch (e) {
      return fail(c, 'storygraph', e instanceof Error ? e.message : String(e))
    }

    // The same resolution the reading tools use for actor_handle, so the rows are keyed
    // on exactly the ap id loadCollapsedBooks is later called with.
    const actor = actorInput.startsWith('http')
      ? { apId: actorInput }
      : await resolveActorByHandle(actorInput)
    if (!actor) {
      return fail(c, 'storygraph', `Fann ikkje kontoen: ${actorInput}`)
    }

    const report = await importStorygraphReads(rows, actor.apId)
    await recordImportRun('storygraph', { ok: true, summary: `${report.booksMatched} bøker kopla, ${report.conflicts.length} konfliktar` })
    return c.html(<StorygraphImportResultPage report={report} />)
  },
)

// LinkedIn monthly analytics export. An upload rather than a watched directory:
// the file is produced by hand on Markus' laptop once a month, so the browser he
// exported it in is where it already is, and docker-compose deliberately uses
// named volumes with no bind mount for the app to watch. See ADR 0033.
app.post(
  '/import/linkedin',
  bodyLimit({ maxSize: 25 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return fail(c, 'linkedin', "Inga fil lasta opp")
    }

    // arrayBuffer(), not text(): an .xlsx is a zip, and decoding it as UTF-8
    // would corrupt it before the parser ever saw it.
    let bytes: ArrayBuffer
    try {
      bytes = await (file as File).arrayBuffer()
    } catch {
      return fail(c, 'linkedin', "Kunne ikkje lese fila")
    }

    let parsed
    try {
      parsed = await parseLinkedinExport(bytes)
    } catch (e) {
      return fail(c, 'linkedin', e instanceof Error ? e.message : String(e))
    }

    const result = await importLinkedinMetrics(parsed)
    logger.info({ ...result }, 'LinkedIn metrics import complete')

    const params = new URLSearchParams({
      actor: `Eksport datert ${result.exportDate}`,
      total: String(result.total),
      imported: String(result.inserted),
      skipped: String(result.skipped),
      errorCount: '0',
    })
    params.set('kind', 'linkedin')
    await recordImportRun('linkedin', { ok: true, summary: `${params.get('imported')} importerte, ${params.get('skipped')} fanst frå før` })
    return c.redirect(`/admin/import/result?${params}`)
  },
)

// YouTube watch history. An upload rather than a sync: there is no API to poll, only a
// file exported by hand — same reasoning as the LinkedIn analytics import above.
//
// The limit is generous enough for the full ~46 MB archive, but the page says plainly
// that the command line is the better path for it: this handler parses inside the SERVER
// process, so a file big enough to exhaust the heap takes the server down with it, where
// `npm run import-youtube-watches` only loses its own process. This form is for the
// incremental exports that follow the first one.
app.post(
  '/import/youtube',
  bodyLimit({ maxSize: 64 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return fail(c, 'youtube', "Inga fil lasta opp")
    }
    const trimmed = (v: unknown) => {
      const s = typeof v === 'string' ? v.trim() : ''
      return s === '' ? undefined : s
    }

    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return fail(c, 'youtube', "Kunne ikkje lese fila")
    }

    let entries: unknown
    try {
      entries = JSON.parse(text)
    } catch (e) {
      return fail(c, 'youtube', `Ikkje gyldig JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!Array.isArray(entries)) {
      return fail(c, 'youtube', "Venta ei JSON-liste med visningar")
    }

    const { total, rows, problems, normalisations } = parseYoutubeWatchHistory(entries, {
      defaultAccount: trimmed(body['account']),
      defaultSource: trimmed(body['source']),
    })

    const result = await importYoutubeWatches(rows)
    logger.info(
      { ...result, failed: result.failed.length, problems: problems.length, normalisations: normalisations.length },
      'YouTube watch import complete (admin upload)',
    )

    // /tuben is ~96k watch events rendered as a hub, five sub-pages and one page per
    // year, and its poller opens with a single fingerprint call that returns early
    // when nothing moved. An import that inserted rows moves that fingerprint, so
    // this wake turns into a real rebuild; one that inserted nothing never gets sent.
    await notifyMsgeChanged('tuben', result.inserted)
    await recordImportRun('youtube', { ok: true, summary: `${result.inserted} nye visningar` })

    // Rendered rather than redirected, unlike the other importers: the problem,
    // normalisation and refusal lists are the substance of this report and will not
    // survive a query string. Re-POSTing on refresh is harmless here — the import is
    // idempotent, so a resubmit inserts zero.
    return c.html(
      <YoutubeImportResultPage
        total={total}
        parsed={rows.length}
        inserted={result.inserted}
        skipped={result.skipped}
        problems={problems}
        normalisations={normalisations}
        failed={result.failed}
      />,
    )
  },
)

app.post('/import/crawl', async (c) => {
  const body = await c.req.parseBody()
  const handle = (body['handle'] as string | undefined)?.trim()
  if (!handle) return fail(c, 'crawl', "Aktøren må fyllast ut")

  const actor = await resolveActorByHandle(handle)
  if (!actor) {
    return fail(c, 'crawl', `Fann ikkje aktøren: ${handle}`)
  }

  let items: unknown[]
  try {
    items = await crawlOutbox(actor.apId)
  } catch (e) {
    return fail(c, 'crawl', `Hentinga av utboksen feila: ${e}`)
  }

  const result = await processActivityBatch(items, (n) => {
    logger.info({ n, total: items.length }, 'Outbox import progress')
  })

  const params = new URLSearchParams({
    actor: handle,
    total: String(result.total),
    imported: String(result.imported),
    skipped: String(result.skipped),
    errorCount: String(result.errors.length),
  })
  params.set('kind', 'crawl')
  await recordImportRun('crawl', { ok: true, summary: `${params.get('imported')} importerte, ${params.get('skipped')} fanst frå før` })
  return c.redirect(`/admin/import/result?${params}`)
})

app.post('/import/reprocess', async (c) => {
  const result = await reprocessActivitiesByType(BARE_OBJECT_TYPES, (n) => {
    logger.info({ n }, 'Reprocess progress')
  })
  const params = new URLSearchParams({
    actor: 'Lagra nakne objekt',
    total: String(result.total),
    imported: String(result.imported),
    skipped: String(result.skipped),
    errorCount: String(result.errors.length),
  })
  params.set('kind', 'reprocess')
  await recordImportRun('reprocess', { ok: true, summary: `${params.get('imported')} importerte, ${params.get('skipped')} fanst frå før` })
  return c.redirect(`/admin/import/result?${params}`)
})

// Rebuild what stored NeoDB marks should have produced: post text, mark-store rows, and
// the catalogue entries get_watched reads. Nothing is re-marked on NeoDB and no post is
// re-federated, so this is safe to press repeatedly.
app.post('/import/repair-neodb', async (c) => {
  const r = await repairNeodbIngest({ force: true })
  const summary = r
    ? `${r.postsRepaired} postar fekk tekst att, ${r.postsRefetched} henta på nytt, ${r.marksUpserted} merke prosesserte, ${r.watchDatesFilled} datoar fylte, ${r.unknownDatesDecoded} ukjende datoar dekoda, ${r.itemsSkipped} alt beriga`
    : 'ingenting å gjere'

  const params = new URLSearchParams({
    actor: summary,
    total: String((r?.itemsEnriched ?? 0) + (r?.itemsFailed ?? 0) + (r?.itemsSkipped ?? 0)),
    imported: String(r?.itemsEnriched ?? 0),
    skipped: String(r?.itemsSkipped ?? 0),
    errorCount: String(r?.itemsFailed ?? 0),
  })
  params.set('kind', 'repair-neodb')
  await recordImportRun('repair-neodb', { ok: true, summary: `${params.get('imported')} importerte, ${params.get('skipped')} fanst frå før` })
  return c.redirect(`/admin/import/result?${params}`)
})

app.get('/import/result', (c) => {
  const actor = c.req.query('actor') ?? ''
  const kind = c.req.query('kind') ?? 'archive'
  const result = {
    total: Number(c.req.query('total') ?? '0'),
    imported: Number(c.req.query('imported') ?? '0'),
    skipped: Number(c.req.query('skipped') ?? '0'),
    errors: Number(c.req.query('errorCount') ?? '0') > 0
      ? [`${c.req.query('errorCount')} feil, sjå serverloggen for detaljar`]
      : [],
  }
  return c.html(<ImportResultPage result={result} actor={actor} kind={kind} />)
})

// After /import/result, so that path is never read as an import's name.
app.get('/import/:kind', (c) => {
  const kind = importKind(c.req.param('kind'))
  return kind ? c.html(<ImportKindPage kind={kind} />) : c.notFound()
})

export { app as adminRouter }
