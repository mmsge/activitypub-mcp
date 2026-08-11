/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import { EmptyRow, fmtDate } from './ui.js'
import type { getPostBreakouts } from '../../mcp/tools/post-breakouts.js'

/**
 * The breakout notifier, seen from the inside.
 *
 * Three questions this page exists to answer, in order of how often they get asked:
 *
 *  1. **Why has nothing arrived?** Either the feature is off, or an account has too
 *     little history for a percentile to mean anything, or nothing has cleared the bar.
 *     Those are three completely different situations and they all look like silence
 *     from the phone. The status card, the `established` badge and the "armed" table
 *     separate them.
 *  2. **Where is the bar right now?** The raw percentiles and the thresholds actually
 *     used, which differ whenever the floor or the strict-ordering rule lifts one.
 *  3. **What has it already said?** So a run of alerts that reads as too chatty can be
 *     traced to the numbers that produced it.
 *
 * See decision record 0036.
 */

type Report = Awaited<ReturnType<typeof getPostBreakouts>>

interface Props {
  report: Extract<Report, { actors: unknown }>
}

const RUNG_LABEL: Record<string, string> = {
  p90: 'p90', p99: 'p99', best: 'record',
}
const RUNG_BADGE: Record<string, string> = {
  p90: 'badge-blue', p99: 'badge-yellow', best: 'badge-green',
}

function Truncate({ text, at = 70 }: { text: string | null; at?: number }) {
  if (!text) return <span style="color:#555">—</span>
  const flat = text.replace(/\s+/g, ' ').trim()
  return <>{flat.length > at ? `${flat.slice(0, at)}…` : flat}</>
}

function Rung({ rung }: { rung: string }) {
  return <span class={`badge ${RUNG_BADGE[rung] ?? 'badge-blue'}`}>{RUNG_LABEL[rung] ?? rung}</span>
}

export function BreakoutsPage({ report }: Props) {
  const armedTotal = report.actors.reduce((n, a) => n + a.armed.length, 0)

  return (
    <Layout title="Breakouts">
      <h1>Breakouts</h1>

      <div class="grid">
        <div class="card">
          <div class="num">
            {report.blocked_reason
              ? <span class="badge badge-red">inert</span>
              : <span class="badge badge-green">armed</span>}
          </div>
          <div class="label">
            {report.blocked_reason ?? `pushing to ${report.topic}`}
          </div>
        </div>
        <div class="card">
          <div class="num">{armedTotal}</div>
          <div class="label">
            armed to fire right now
            {armedTotal > 0 && !report.blocked_reason
              ? ' — if none of these arrive, the push is failing, not the bar'
              : ''}
          </div>
        </div>
        <div class="card">
          <div class="num">{report.recent.length}</div>
          <div class="label">announced recently</div>
        </div>
        <div class="card">
          <div class="num" style="font-size:20px">
            {report.weights.favourites} / {report.weights.reblogs} / {report.weights.replies}
          </div>
          <div class="label">
            weights: hjarte / framheving / svar · floor {report.floor} · digest{' '}
            {report.digest_hour < 0 ? 'off' : `${report.digest_hour}:00`} · fast lane{' '}
            {report.fast_lane_minutes === 0 ? 'off' : `${report.fast_lane_minutes} min`}
          </div>
        </div>
      </div>

      <h2>Where each bar sits</h2>
      <p style="color:#888; margin-bottom:12px; font-size:12px">
        A post's score is its <strong>peak</strong> across the whole snapshot history, never
        its latest reading — engagement counts go down, and a withdrawn favourite must not
        lower the bar. The percentiles are over the last {report.actors[0]?.baseline.window_days ?? '—'}{' '}
        days; the record is all-time. “Threshold” is what a post must actually reach after
        the floor is applied and the rungs are forced apart.
      </p>
      <table style="margin-bottom:24px">
        <thead>
          <tr>
            <th>Account</th>
            <th>Posts in window</th>
            <th>Median</th>
            <th>p90 → threshold</th>
            <th>p99 → threshold</th>
            <th>Record → threshold</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {report.actors.length === 0 && <EmptyRow colspan={7} text="No watched accounts." />}
          {report.actors.map((a) => (
            <tr>
              <td>{a.actor}</td>
              <td>{a.baseline.posts_in_window}</td>
              <td>{Math.round(a.baseline.median)}</td>
              <td>{Math.round(a.baseline.p90)} → <strong>{a.thresholds.p90}</strong></td>
              <td>{Math.round(a.baseline.p99)} → <strong>{a.thresholds.p99}</strong></td>
              <td>{a.baseline.best} → <strong>{a.thresholds.best}</strong></td>
              <td>
                {a.baseline.established
                  ? <span class="badge badge-green">established</span>
                  : (
                    <span class="badge badge-yellow" title="Nothing fires for this account">
                      too few posts ({a.baseline.posts_in_window}/{report.min_posts})
                    </span>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Armed right now</h2>
      <p style="color:#888; margin-bottom:12px; font-size:12px">
        Posts that clear a rung further than anything already announced for them. On a
        working deployment this empties itself within the hour — a row that sits here is
        the sign that the push is failing rather than that nothing qualifies.
      </p>
      <table style="margin-bottom:24px">
        <thead>
          <tr>
            <th>Post</th>
            <th>Account</th>
            <th>Peak</th>
            <th>Now</th>
            <th>Counts</th>
            <th>Would fire</th>
            <th>Already spent</th>
          </tr>
        </thead>
        <tbody>
          {armedTotal === 0 && <EmptyRow colspan={7} text="Nothing armed." />}
          {report.actors.flatMap((a) => a.armed.map((p) => (
            <tr>
              <td>
                {p.url
                  ? <a href={p.url} target="_blank" rel="noreferrer" style="color:#7c6ef7">
                      <Truncate text={p.text} />
                    </a>
                  : <Truncate text={p.text} />}
                {p.visibility && p.visibility !== 'public' && (
                  <> <span class="badge badge-yellow">{p.visibility}</span></>
                )}
              </td>
              <td>{a.actor}</td>
              <td><strong>{p.peak_score}</strong></td>
              <td style={p.score < p.peak_score ? 'color:#888' : ''}>{p.score}</td>
              <td style="color:#888">{p.favourites} / {p.reblogs} / {p.replies}</td>
              <td><Rung rung={p.would_fire} /></td>
              <td>{p.spent_rung ? <Rung rung={p.spent_rung} /> : <span style="color:#555">—</span>}</td>
            </tr>
          )))}
        </tbody>
      </table>

      <h2>Already announced</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Rung</th>
            <th>Account</th>
            <th>Post</th>
            <th>Score then</th>
            <th>Peak</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {report.recent.length === 0 && (
            <EmptyRow colspan={7} text="Nothing announced yet. A first run seeds silently — that is deliberate." />
          )}
          {report.recent.map((r) => (
            <tr>
              <td>{fmtDate(r.fired_at)}</td>
              <td><Rung rung={r.rung} /></td>
              <td>{r.actor}</td>
              <td>
                {r.url
                  ? <a href={r.url} target="_blank" rel="noreferrer" style="color:#7c6ef7">
                      <Truncate text={r.text} />
                    </a>
                  : <Truncate text={r.text} />}
              </td>
              <td><strong>{r.score}</strong></td>
              <td>{r.peak_score}</td>
              {/* Lower than the peak means engagement was withdrawn. Real, and shown
                  rather than hidden — the rung it earned is not taken back. */}
              <td style={r.current_score < r.peak_score ? 'color:#888' : ''}>{r.current_score}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}
