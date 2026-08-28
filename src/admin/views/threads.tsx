/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import { EmptyRow, fmtDate } from './ui.js'
import type { getThreadLeaderboard } from '../../mcp/tools/thread-leaderboard.js'
import type { FailingRoot } from '../../lib/thread-store.js'

/**
 * The thread walker, seen from the inside.
 *
 * Three questions, in the order they get asked:
 *
 *  1. **Why is the leaderboard empty?** Either the walker is disabled, or no actor
 *     resolved, or the backfill has never been run. Those are three different fixes and
 *     they all look like an empty table. The status cards separate them: `roots walked`
 *     against `roots total` is the one number that says whether a backfill is owed.
 *  2. **What is failing?** A root that 404s or times out keeps its previously stored
 *     tree — deliberately, so a bad fetch never reads as "this conversation emptied" —
 *     which means a persistent failure is invisible unless it is listed. It is listed.
 *  3. **What actually started a conversation?** The leaderboard, with the same numbers
 *     `get_thread_leaderboard` returns, from the same handler.
 *
 * Called with NO scope, so this sees unlisted roots too — the admin is the owner, the
 * same choice /admin/breakouts makes (ADR 0026).
 *
 * There is no reply text on this page because there is none in the database. See
 * decision record 0057.
 */

type Report = Awaited<ReturnType<typeof getThreadLeaderboard>>

interface Props {
  report: Extract<Report, { threads: unknown }>
  failures: FailingRoot[]
}

function Truncate({ text, at = 80 }: { text: string | null; at?: number }) {
  if (!text) return <span style="color:#555">—</span>
  const flat = text.replace(/\s+/g, ' ').trim()
  return <>{flat.length > at ? `${flat.slice(0, at)}…` : flat}</>
}

export function ThreadsPage({ report, failures }: Props) {
  const { walk } = report
  const unwalked = Math.max(0, walk.roots_total - walk.roots_walked)

  return (
    <Layout title="Threads">
      <h1>Threads</h1>

      <div class="grid">
        <div class="card">
          <div class="num">
            {walk.blocked_reason
              ? <span class="badge badge-red">off</span>
              : <span class="badge badge-green">on</span>}
          </div>
          <div class="label">
            {walk.blocked_reason ?? `walking every ${walk.interval_hours} h`}
            {' · last '}{walk.last_walk_at ? fmtDate(walk.last_walk_at) : 'never'}
          </div>
        </div>
        <div class="card">
          <div class="num">{walk.roots_walked.toLocaleString('en')}</div>
          <div class="label">
            of {walk.roots_total.toLocaleString('en')} roots walked
            {unwalked > 0
              ? ` — ${unwalked.toLocaleString('en')} still owed a backfill`
              : ''}
          </div>
        </div>
        <div class="card">
          <div class="num">{walk.roots_unsettled.toLocaleString('en')}</div>
          <div class="label">
            unsettled — the daily pass's queue. A thread settles once its newest node is{' '}
            {walk.settled_days} days old; only a backfill revisits it after that.
          </div>
        </div>
        <div class="card">
          <div class="num">
            {walk.roots_failing > 0
              ? <span class="badge badge-red">{walk.roots_failing}</span>
              : <span class="badge badge-green">0</span>}
          </div>
          <div class="label">
            roots whose last walk failed — their stored tree is kept, not emptied
          </div>
        </div>
      </div>

      <h2>Leaderboard</h2>
      <p style="color:#888; margin-bottom:12px; font-size:12px">
        Ranked by <strong>external replies</strong> — nodes somebody else wrote. The root
        counts as node 0 and is his, so a thread he is only talking to himself in scores
        zero here and is left out entirely. Depth is hops from the root.{' '}
        <strong>No reply text appears on this page because none is stored:</strong> the walk
        keeps ids, permalinks, depths and <code>@user@host</code> handles, and the schema's
        CHECK constraints are what keep it that way.
      </p>
      <table style="margin-bottom:24px">
        <thead>
          <tr>
            <th>Root toot</th>
            <th>Posted</th>
            <th style="text-align:right">External</th>
            <th style="text-align:right">Total</th>
            <th style="text-align:right">Depth</th>
            <th style="text-align:right">People</th>
            <th>Newest node</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {report.threads.length === 0 && (
            <EmptyRow
              colspan={8}
              text={
                walk.roots_walked === 0
                  ? 'Nothing walked yet — run `npm run walk-threads -- --backfill`.'
                  : 'Nothing walked has drawn a reply from anyone else.'
              }
            />
          )}
          {report.threads.map((t) => (
            <tr>
              <td>
                {t.url
                  ? <a href={t.url} target="_blank" rel="noreferrer"><Truncate text={t.text} /></a>
                  : <Truncate text={t.text} />}
              </td>
              <td>{fmtDate(t.published_at)}</td>
              <td style="text-align:right"><strong>{t.external_node_count}</strong></td>
              <td style="text-align:right">{t.node_count}</td>
              <td style="text-align:right">{t.max_depth}</td>
              <td style="text-align:right">{t.external_participant_count}</td>
              <td>{fmtDate(t.newest_node_at)}</td>
              <td>
                {t.settled
                  ? <span class="badge badge-green" title="Newest node is older than the settle window; only a backfill revisits this.">settled</span>
                  : <span class="badge badge-blue" title="Still in the daily pass's queue.">open</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Walks that failed</h2>
      <p style="color:#888; margin-bottom:12px; font-size:12px">
        A failed fetch never overwrites a stored tree — a 404 or a timeout must not read as
        “this conversation emptied”. That makes a persistent failure invisible unless it is
        listed here, so it is.
      </p>
      <table>
        <thead>
          <tr>
            <th>Root</th>
            <th>Last tried</th>
            <th style="text-align:right">Attempts</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {failures.length === 0 && <EmptyRow colspan={4} text="No failing walks." />}
          {failures.map((f) => (
            <tr>
              <td>
                <a href={f.url ?? f.rootApId} target="_blank" rel="noreferrer">
                  {f.url ?? f.rootApId}
                </a>
              </td>
              <td>{fmtDate(f.walkedAt)}</td>
              <td style="text-align:right">{f.walkAttempts}</td>
              <td style="color:#c66">{f.walkError}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}
