/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { Layout } from './layout.js'
import type { ImportResult } from '../import.js'
import type { ParseProblem, ParseNormalisation } from '../../lib/parse-youtube-takeout.js'
import type { RowFailure } from '../../jobs/import-youtube-watches.js'

export const ImportPage: FC<{ error?: string }> = ({ error }) => (
  <Layout title="Import">
    <h1>Import Historical Activities</h1>

    {error && <div class="error">{error}</div>}

    <div class="section">
      <h2>Mastodon Archive</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Export your archive from <strong>Mastodon Settings → Export → Request your archive</strong>.
        Extract the <code>.tar.gz</code> and upload the <code>outbox.json</code> file.
      </p>
      <form method="post" action="/admin/import/archive" enctype="multipart/form-data">
        <div class="filters">
          <input type="file" name="archive" accept=".json" required />
          <button type="submit">Import Archive</button>
        </div>
      </form>
    </div>

    <div class="section">
      <h2>Crawl ActivityPub Outbox</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Enter an actor handle to fetch their full public post history. Works with Mastodon and BookWyrm.
        May take a minute for large accounts (up to 200 pages).
      </p>
      <form method="post" action="/admin/import/crawl">
        <div class="filters">
          <input
            type="text"
            name="handle"
            placeholder="@user@instance.social"
            style="width: 280px;"
            required
          />
          <button type="submit">Crawl Outbox</button>
        </div>
      </form>
    </div>
    <div class="section">
      <h2>Train Trips (CSV)</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Upload a <strong>viaduct.world</strong> CSV export of your train journeys. A trip is
        identified by its departure time and its two stations, so re-exporting a leg after
        travelling it <em>updates</em> the stored one — filling in the train code, the delay and
        the real distance, and moving it from Planned to Completed — rather than storing it a
        second time. Re-importing an unchanged export writes nothing at all.
      </p>
      <form method="post" action="/admin/import/trips" enctype="multipart/form-data">
        <div class="filters">
          <input type="file" name="file" accept=".csv,text/csv" required />
          <button type="submit">Import Trips</button>
        </div>
      </form>
    </div>

    <div class="section">
      <h2>LinkedIn Analytics (XLSX)</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Upload a <strong>LinkedIn Content export</strong> (analytics dashboard → Export →
        Content, last 90 days is a good default). Impressions and engagements per post are
        read from the <strong>TOP POSTS</strong> sheet and stored append-only, one row per
        post per export — successive exports build the reach-decay series rather than
        overwriting each other. The export is dated from its own reporting window, so
        re-uploading the same file is safe.
      </p>
      <form method="post" action="/admin/import/linkedin" enctype="multipart/form-data">
        <div class="filters">
          <input
            type="file"
            name="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
          />
          <button type="submit">Import LinkedIn Metrics</button>
        </div>
      </form>
    </div>

    <div class="section">
      <h2>YouTube Watch History (JSON)</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Upload a Google Takeout-shaped <strong>watch-history.json</strong> (Takeout →
        YouTube and YouTube Music → history, or a My Activity scrape). Idempotent on
        (account, video, local minute), so re-uploading an overlapping export adds only
        what is missing. Nothing is ever updated.
      </p>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        <strong>For the full ~46 MB archive, prefer the command line:</strong>{' '}
        <code>npm run import-youtube-watches -- &lt;path&gt;</code>. That runs in its own
        process; this upload is parsed inside the server, so a file large enough to exhaust
        the heap would take the server down with it rather than just failing the import.
        This form is meant for the incremental exports that follow the first one.
      </p>
      <form method="post" action="/admin/import/youtube" enctype="multipart/form-data">
        <div class="filters">
          <input type="file" name="file" accept=".json,application/json" required />
          <input name="account" placeholder="Account (if the file has none)" style="width:220px" />
          <input name="source" placeholder="Source (e.g. takeout-2026-08)" style="width:220px" />
          <button type="submit">Import Watch History</button>
        </div>
      </form>
    </div>


    <div class="section">
      <h2>Re-process Stored Bare Objects</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Re-runs processing on activities stored as bare Note/Review/etc. objects
        (e.g. from a BookWyrm outbox crawl) so they appear as queryable posts.
        Safe to run multiple times.
      </p>
      <form method="post" action="/admin/import/reprocess">
        <div class="filters">
          <button type="submit">Re-process Bare Objects</button>
        </div>
      </form>
    </div>

    <div class="section">
      <h2>Repair NeoDB Marks</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Walks stored posts that look like NeoDB marks and rebuilds what they should have
        produced: re-derives missing post text from the stored object, upserts the mark
        store, and enriches every catalogue item the marks tag (so they show up in{' '}
        <strong>get_watched</strong>). Also fills in the shelf date (<strong>watched_at</strong>)
        for marks ingested before that column existed, reading it back out of the stored
        payload — blanks only, never overwriting a date already recorded. Nothing is
        re-marked on NeoDB and no post is re-federated. Safe to run multiple times —
        enrichment only fetches items that are missing or previously failed.
      </p>
      <form method="post" action="/admin/import/repair-neodb">
        <div class="filters">
          <button type="submit">Repair NeoDB Marks</button>
        </div>
      </form>
    </div>
  </Layout>
)

export const ImportResultPage: FC<{
  // `updated` only comes from the trips importer, which matches an incoming trip to the
  // stored one and refreshes it in place (ADR 0048). The other importers insert or skip.
  result: ImportResult & { updated?: number }
  actor: string
}> = ({ result, actor }) => (
  <Layout title="Import Result">
    <h1>Import Complete</h1>
    {actor && <p style="color: #888; margin-bottom: 20px;">{actor}</p>}

    <div class="grid" style="margin-bottom: 24px;">
      <div class="card">
        <div class="num">{result.total}</div>
        <div class="label">Total activities</div>
      </div>
      <div class="card">
        <div class="num" style="color: #4ade80;">{result.imported}</div>
        <div class="label">Imported</div>
      </div>
      {result.updated !== undefined && (
        <div class="card">
          <div class="num" style="color: #60a5fa;">{result.updated}</div>
          <div class="label">Updated in place</div>
        </div>
      )}
      <div class="card">
        <div class="num" style="color: #888;">{result.skipped}</div>
        <div class="label">Skipped (already exist)</div>
      </div>
      <div class="card">
        <div class="num" style="color: #f87171;">{result.errors.length}</div>
        <div class="label">Errors</div>
      </div>
    </div>

    {result.errors.length > 0 && (
      <div class="section">
        <h2>Errors (first {Math.min(result.errors.length, 20)})</h2>
        <pre>{result.errors.slice(0, 20).join('\n')}</pre>
      </div>
    )}

    <div class="filters">
      <a href="/admin/import" class="btn">Import More</a>
      <a href="/admin/objects" class="btn" style="background: #333;">View Posts</a>
    </div>
  </Layout>
)

/**
 * The watch-history importer reports more than the generic result page can hold, and the
 * extra is the point: entries it refused, and values it CHANGED. A normalisation is not an
 * error — the row survives — but the archive no longer says exactly what the source said,
 * and that must not be the one thing the web path quietly drops. See ADR 0047.
 */
export const YoutubeImportResultPage: FC<{
  total: number
  parsed: number
  inserted: number
  skipped: number
  problems: ParseProblem[]
  normalisations: ParseNormalisation[]
  failed: RowFailure[]
}> = ({ total, parsed, inserted, skipped, problems, normalisations, failed }) => {
  const byReason = <T extends { reason?: string; kind?: string }>(list: T[]) => {
    const m = new Map<string, T[]>()
    for (const x of list) {
      const key = x.reason ?? x.kind ?? 'unknown'
      m.set(key, [...(m.get(key) ?? []), x])
    }
    return [...m].sort((a, b) => b[1].length - a[1].length)
  }

  return (
    <Layout title="Import Result">
      <h1>Watch History Imported</h1>
      <p style="color: #888; margin-bottom: 20px;">
        {parsed} of {total} entries parsed
      </p>

      <div class="grid" style="margin-bottom: 24px;">
        <div class="card">
          <div class="num">{total}</div>
          <div class="label">Entries in file</div>
        </div>
        <div class="card">
          <div class="num" style="color: #4ade80;">{inserted}</div>
          <div class="label">Inserted</div>
        </div>
        <div class="card">
          <div class="num" style="color: #888;">{skipped}</div>
          <div class="label">Already present</div>
        </div>
        <div class="card">
          <div class="num" style={normalisations.length ? 'color: #60a5fa;' : 'color: #888;'}>
            {normalisations.length}
          </div>
          <div class="label">Normalised</div>
        </div>
        <div class="card">
          <div class="num" style={problems.length + failed.length ? 'color: #f87171;' : 'color: #888;'}>
            {problems.length + failed.length}
          </div>
          <div class="label">Not imported</div>
        </div>
      </div>

      {normalisations.length > 0 && (
        <div class="section">
          <h2>Normalised — kept, but altered</h2>
          <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
            These rows are in the database, but not with the value the file gave. Shown so
            the change is never silent.
          </p>
          {byReason(normalisations).map(([kind, list]) => (
            <div key={kind} style="margin-bottom: 12px;">
              <strong>{list.length}</strong> — {kind}
              <pre>{list.slice(0, 20).map((n) => `entry ${n.index}: ${n.from} -> ${n.to}`).join('\n')}</pre>
            </div>
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <div class="section">
          <h2>Entries that could not be parsed</h2>
          {byReason(problems).map(([reason, list]) => (
            <div key={reason} style="margin-bottom: 12px;">
              <strong>{list.length}</strong> — {reason}
              <pre>{list.slice(0, 10).map((p) => `entry ${p.index}: ${p.sample}`).join('\n')}</pre>
            </div>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div class="section">
          <h2>Rows the database refused</h2>
          {byReason(failed).map(([reason, list]) => (
            <div key={reason} style="margin-bottom: 12px;">
              <strong>{list.length}</strong> — {reason}
              <pre>{list.slice(0, 10).map((f) => `row ${f.index}: ${f.account} ${f.watchedAtLocal} ${f.videoId}`).join('\n')}</pre>
            </div>
          ))}
        </div>
      )}

      <div class="filters">
        <a href="/admin/import" class="btn">Import More</a>
        <a href="/admin/media?tab=youtube" class="btn" style="background: #333;">View Watch History</a>
      </div>
    </Layout>
  )
}
