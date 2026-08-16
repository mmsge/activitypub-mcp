// Check an imported YouTube watch archive against the numbers it is supposed to hold.
//
//   npm run youtube-import-verify              # check against the full-archive expectations
//   npm run youtube-import-verify -- --report  # just print what is there, assert nothing
//
// READ-ONLY. It never writes, and it is safe to run against production.
//
// The expectations below describe the full 96,515-row archive. Run this after importing
// it — and after importing it a SECOND time, since the headline property of the importer
// is that the second run changes nothing.
//
// Exits 0 when every check passes, 1 otherwise. Use --report on a partial import (say the
// 186-entry sample) where the full-archive numbers do not apply.
import { sql } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/client.js'

const reportOnly = process.argv.includes('--report')

/** What the full archive is supposed to contain, per the export it was built from. */
const EXPECTED = {
  total: 96_515,
  perAccount: { mvrkws: 94_834, rawen100: 1_681 },
  distinctVideos: 92_292,
  // BY NAME, not by id — settled by the first full import, which reported 25,510 distinct
  // channel ids against 25,417 distinct names. The archive's own figure counts names, and
  // ids exceed names because 93 channels share a display name with another channel.
  //
  // The tools still count `distinct_channels` on the ID, which is the better identity, and
  // report `distinct_channel_names` beside it. The two answer different questions; this is
  // the one that reproduces the source.
  distinctChannelNames: 25_417,
  distinctChannelIds: 25_510,
  unresolved: 10_962,
  withDuration: 85_543,
  busiestMinuteEntries: 31,
  mostRewatched: 24,
  newest: {
    mvrkws: { at: '2026-08-16T18:08:00', title: 'So Much Has Happened This Week!', channel: 'JackSucksAtStuff' },
    rawen100: { at: '2026-07-16T18:43:00', title: '1Password for Claude: For Everyday AI Users', channel: '1Password' },
  },
  // Per account per year, on the LOCAL wall clock. Lumpy on purpose: 2025 against 2024 is
  // a 62x discontinuity, and reproducing it exactly is the point of bucketing on
  // watched_at_local rather than on the instant.
  perYear: {
    mvrkws: {
      2015: 1417, 2016: 4077, 2017: 2139, 2018: 2423, 2019: 5235, 2020: 8697,
      2021: 3809, 2022: 2187, 2023: 1527, 2024: 866, 2025: 53_360, 2026: 9097,
    },
    rawen100: {
      2010: 176, 2011: 903, 2012: 19, 2013: 34, 2014: 16, 2015: 66, 2016: 3,
      2018: 14, 2019: 5, 2020: 85, 2021: 9, 2022: 15, 2023: 3, 2024: 32,
      2025: 300, 2026: 1,
    },
  },
} as const

let failures = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown) {
  checks++
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  const mark = reportOnly ? ' ' : ok ? '✓' : '✗'
  const suffix = reportOnly ? '' : ok ? '' : `   EXPECTED ${expected}`
  console.log(` ${mark} ${label.padEnd(42)} ${String(actual).padStart(8)}${suffix}`)
}

function report(label: string, actual: unknown) {
  console.log(`   ${label.padEnd(42)} ${String(actual).padStart(8)}`)
}

try {
  const db = getDb()
  const one = async <T>(q: string): Promise<T> =>
    (await db.execute(sql.raw(q))).at(0) as T

  console.log(reportOnly ? '\nYouTube watch archive — report\n' : '\nYouTube watch archive — verification\n')

  // --- totals ---------------------------------------------------------------
  const totals = await one<{ n: string; videos: string; channels: string; names: string; unresolved: string; dur: string }>(`
    SELECT count(*) AS n,
           count(DISTINCT video_id) AS videos,
           count(DISTINCT channel_id) AS channels,
           count(DISTINCT channel_name) AS names,
           count(*) FILTER (WHERE unresolved) AS unresolved,
           count(*) FILTER (WHERE duration_seconds IS NOT NULL) AS dur
    FROM youtube_watches`)

  console.log('Totals')
  check('total watches', totals.n, EXPECTED.total)
  check('distinct videos', totals.videos, EXPECTED.distinctVideos)
  // Both are asserted, because the gap between them is itself a fact about the archive:
  // 93 channels share a display name with another channel, so counting by name merges
  // them. The source's own 25,417 is the name count; the id count is the truer identity.
  check('distinct channels (by name)', totals.names, EXPECTED.distinctChannelNames)
  check('distinct channels (by id)', totals.channels, EXPECTED.distinctChannelIds)
  check('unresolved', totals.unresolved, EXPECTED.unresolved)
  check('with a duration', totals.dur, EXPECTED.withDuration)

  // --- per account ----------------------------------------------------------
  console.log('\nPer account')
  const accounts = (await db.execute(sql.raw(
    'SELECT account, count(*) AS n FROM youtube_watches GROUP BY account ORDER BY account',
  ))) as unknown as Array<{ account: string; n: string }>
  for (const [name, expected] of Object.entries(EXPECTED.perAccount)) {
    check(name, accounts.find((a) => a.account === name)?.n ?? 0, expected)
  }
  for (const a of accounts) {
    if (!(a.account in EXPECTED.perAccount)) report(`${a.account} (unexpected account)`, a.n)
  }

  // --- per account per year -------------------------------------------------
  // Bucketed on watched_at_local. Read off the instant instead, the hours either side of
  // New Year land in the wrong year and these counts drift.
  console.log('\nPer account per year (local wall clock)')
  const years = (await db.execute(sql.raw(`
    SELECT account, extract(year FROM watched_at_local)::int AS y, count(*) AS n
    FROM youtube_watches GROUP BY account, y ORDER BY account, y`))) as unknown as
    Array<{ account: string; y: number; n: string }>

  for (const [account, table] of Object.entries(EXPECTED.perYear)) {
    for (const [year, expected] of Object.entries(table)) {
      const got = years.find((r) => r.account === account && String(r.y) === year)?.n ?? 0
      check(`${account} ${year}`, got, expected)
    }
    for (const r of years.filter((r) => r.account === account)) {
      if (!(String(r.y) in table)) check(`${account} ${r.y} (unexpected year)`, r.n, 0)
    }
  }

  // --- the collisions the dedupe key must preserve --------------------------
  console.log('\nCollisions the natural key must preserve')
  const minute = await one<{ n: string; account: string; at: string }>(`
    SELECT count(*) AS n, account, to_char(watched_at_local, 'YYYY-MM-DD"T"HH24:MI') AS at
    FROM youtube_watches GROUP BY account, watched_at_local
    ORDER BY count(*) DESC, at LIMIT 1`)
  check('most entries in one minute', minute.n, EXPECTED.busiestMinuteEntries)
  report(`  that minute`, `${minute.account} ${minute.at}`)

  // Per VIDEO, not per (account, video). The archive's own figure counts videos, and the
  // two differ: the most-rewatched video is watched on BOTH accounts, so keying on the
  // pair splits one 24-watch video into a 20 and a 4 and understates it. The per-account
  // maximum is reported beside it so the split stays visible rather than looking like a
  // discrepancy.
  const rewatch = await one<{ n: string; video_id: string }>(`
    SELECT count(*) AS n, video_id FROM youtube_watches
    GROUP BY video_id ORDER BY count(*) DESC, video_id LIMIT 1`)
  check('most watches of one video', rewatch.n, EXPECTED.mostRewatched)
  report('  that video', rewatch.video_id)

  const perAccountRewatch = await one<{ n: string; account: string; video_id: string }>(`
    SELECT count(*) AS n, account, video_id FROM youtube_watches
    GROUP BY account, video_id ORDER BY count(*) DESC, video_id LIMIT 1`)
  report('  most by a single account', `${perAccountRewatch.n} (${perAccountRewatch.account} ${perAccountRewatch.video_id})`)

  const dupes = await one<{ n: string }>(`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM youtube_watches
      GROUP BY account, video_id, watched_at_local HAVING count(*) > 1
    ) d`)
  // Zero by construction — the unique index enforces it — but a second import that
  // somehow doubled rows would show up here first.
  check('duplicate natural keys', dupes.n, 0)

  // --- the newest watch per account, and the timezone spot check ------------
  console.log('\nNewest watch per account (and the timezone spot check)')
  for (const [account, want] of Object.entries(EXPECTED.newest)) {
    const row = await one<{ at: string; title: string | null; channel: string | null; instant: string }>(`
      SELECT to_char(watched_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
             title, channel_name AS channel,
             to_char(watched_at AT TIME ZONE 'Europe/Oslo', 'YYYY-MM-DD"T"HH24:MI:SS') AS instant
      FROM youtube_watches WHERE account = '${account}'
      ORDER BY watched_at DESC LIMIT 1`)
    check(`${account} newest local time`, row.at, want.at)
    check(`${account} newest title`, row.title, want.title)
    check(`${account} newest channel`, row.channel, want.channel)
    // The instant must round-trip back to the same wall clock. If this fails, the local
    // time was resolved with the wrong zone — the exact bug the two-column split exists
    // to prevent, and one that leaves every row looking plausible.
    check(`${account} instant round-trips to local`, row.instant, want.at)
  }

  // --- shape, for context rather than assertion -----------------------------
  console.log('\nShape (reported, not asserted)')
  const shape = await one<{ shorts: string; long: string; unknown: string; raw: string; capped: string }>(`
    SELECT count(*) FILTER (WHERE duration_seconds < 180) AS shorts,
           count(*) FILTER (WHERE duration_seconds >= 180) AS long,
           count(*) FILTER (WHERE duration_seconds IS NULL) AS unknown,
           coalesce(sum(duration_seconds), 0) AS raw,
           -- FILTER because Postgres' least() ignores nulls: least(NULL, 1200) is 1200,
           -- so without it every duration-less row adds a fabricated 20 minutes.
           coalesce(sum(least(duration_seconds, 1200))
                    FILTER (WHERE duration_seconds IS NOT NULL), 0) AS capped
    FROM youtube_watches`)
  report('Shorts (<180s)', shape.shorts)
  report('long form (>=180s)', shape.long)
  report('unknown duration', shape.unknown)
  report('raw hours (UPPER BOUND)', Math.round(Number(shape.raw) / 3600))
  report('capped-20min hours (UPPER BOUND)', Math.round(Number(shape.capped) / 3600))

  // An internal invariant, asserted rather than reported: capping each row can only ever
  // lower the total, so capped > raw is impossible and means the capped sum is counting
  // rows it should not. That is exactly how the least()-ignores-nulls bug announced
  // itself on the first full import, and unlike the expected counts this check needs no
  // prior knowledge of the archive — it holds for any data, including a partial import.
  console.log('\nInternal consistency')
  checks++
  const cappedOverRaw = Number(shape.capped) > Number(shape.raw)
  if (cappedOverRaw) failures++
  console.log(
    ` ${reportOnly ? ' ' : cappedOverRaw ? '✗' : '✓'} ${'capped <= raw'.padEnd(42)} ` +
    `${cappedOverRaw ? 'VIOLATED — the capped sum is counting duration-less rows' : 'holds'}`,
  )
  console.log('\n   Both hour figures are upper bounds on a quantity this data does not')
  console.log('   contain: no watch duration is recorded anywhere, only that a video was')
  console.log('   opened. Never quote either without that caveat.')

  if (reportOnly) {
    console.log('\n--report: nothing was asserted.\n')
    await closeDb()
    process.exit(0)
  }

  console.log(
    failures === 0
      ? `\nAll ${checks} checks passed.\n`
      : `\n${failures} of ${checks} checks FAILED.\n`,
  )
  await closeDb()
  process.exit(failures === 0 ? 0 : 1)
} catch (e) {
  console.error(e)
  await closeDb().catch(() => {})
  process.exit(1)
}
