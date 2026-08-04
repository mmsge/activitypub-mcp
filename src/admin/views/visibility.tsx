/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import { EmptyRow } from './ui.js'

/**
 * The pre-launch check for the public stream.
 *
 * Publishing the archive is the one irreversible step in this feature: a post that
 * should not have been public is public the moment a crawler sees it. The
 * classifier fails closed and is heavily tested, but tests are written against
 * what we *think* the five platforms send. This page is where that meets 5,000
 * real rows before anyone else can read them.
 *
 * Read it with the site still switched off (STREAM_DOMAIN unset), and check three
 * things: that the public counts per account are roughly what you expect, that a
 * sample of withheld rows really should be withheld, and that a sample of
 * publishable rows really was public at the origin.
 */

export interface VisibilityCount {
  actorApId: string
  handle: string | null
  software: string | null
  visibility: string
  count: number
}

export interface VisibilitySample {
  apId: string
  url: string | null
  visibility: string
  publishedAt: Date | null
  contentText: string | null
  to: string | null
  cc: string | null
}

interface Props {
  counts: VisibilityCount[]
  withheld: VisibilitySample[]
  publishable: VisibilitySample[]
  unknownTotal: number
  streamEnabled: boolean
  streamDomain: string
  includeUnlisted: boolean
  configuredHandles: string[]
  unresolvedHandles: string[]
  markCounts: { total: number; withNote: number; withoutNote: number }
}

const LABEL: Record<string, string> = {
  public: 'Public — will be published',
  unlisted: 'Unlisted — withheld unless STREAM_INCLUDE_UNLISTED',
  private: 'Followers-only or direct — never published',
  unknown: 'No readable addressing — never published',
}

const COLOUR: Record<string, string> = {
  public: '#4ade80', unlisted: '#fbbf24', private: '#888', unknown: '#f87171',
}

function Truncate({ text, at = 90 }: { text: string | null; at?: number }) {
  if (!text) return <span style="color:#555">—</span>
  return <>{text.length > at ? `${text.slice(0, at)}…` : text}</>
}

export function VisibilityPage(props: Props) {
  const byActor = new Map<string, VisibilityCount[]>()
  for (const c of props.counts) {
    const key = c.handle ?? c.actorApId
    byActor.set(key, [...(byActor.get(key) ?? []), c])
  }
  const grand = props.counts.reduce((sum, c) => sum + c.count, 0)
  const publicTotal = props.counts.filter((c) => c.visibility === 'public')
    .reduce((s, c) => s + c.count, 0)

  return (
    <Layout title="Visibility">
      <h1>Visibility</h1>

      <div class="card" style="margin-bottom:24px">
        <p style="margin:0 0 8px">
          <strong>Public stream:</strong>{' '}
          {props.streamEnabled
            ? <span style="color:#4ade80">live at {props.streamDomain}</span>
            : <span style="color:#fbbf24">off — STREAM_DOMAIN is unset</span>}
        </p>
        <p style="margin:0 0 8px;color:#888;font-size:13px">
          {publicTotal.toLocaleString('en')} of {grand.toLocaleString('en')} archived
          posts classify as public. Unlisted posts are{' '}
          {props.includeUnlisted
            ? <strong style="color:#fbbf24">included</strong>
            : <>excluded</>}.
        </p>
        {props.unknownTotal > 0 ? (
          <p style="margin:0;color:#f87171;font-size:13px">
            {props.unknownTotal.toLocaleString('en')} rows carry no readable{' '}
            <code>to</code>/<code>cc</code> and are withheld. That is the fail-closed
            path working; if the number is large or growing, a platform may have
            changed how it serialises addressing.
          </p>
        ) : null}
      </div>

      <h2>Configured sources</h2>
      <div class="card" style="margin-bottom:24px">
        {props.configuredHandles.length === 0 ? (
          <p style="margin:0;color:#fbbf24">
            STREAM_SOURCES is empty — nothing can be published.
          </p>
        ) : (
          <p style="margin:0;font-size:13px">
            {props.configuredHandles.map((h) => <code style="margin-right:10px">{h}</code>)}
          </p>
        )}
        {props.unresolvedHandles.length > 0 ? (
          <p style="margin:8px 0 0;color:#f87171;font-size:13px">
            Not resolvable to a stored actor, so silently excluded:{' '}
            {props.unresolvedHandles.map((h) => <code style="margin-right:8px">{h}</code>)}
          </p>
        ) : null}
      </div>

      <h2>Counts by account</h2>
      <table style="margin-bottom:24px">
        <thead>
          <tr><th>Account</th><th>Software</th><th>Classification</th><th style="text-align:right">Posts</th></tr>
        </thead>
        <tbody>
          {props.counts.length === 0 ? <EmptyRow colspan={4} /> : null}
          {[...byActor.entries()].flatMap(([handle, rows]) =>
            rows.sort((a, b) => b.count - a.count).map((r, i) => (
              <tr>
                <td>{i === 0 ? handle : ''}</td>
                <td style="color:#888">{i === 0 ? r.software ?? '—' : ''}</td>
                <td style={`color:${COLOUR[r.visibility] ?? '#888'}`}>
                  {LABEL[r.visibility] ?? r.visibility}
                </td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">
                  {r.count.toLocaleString('en')}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>

      <h2>NeoDB marks</h2>
      <div class="card" style="margin-bottom:24px">
        <p style="margin:0;font-size:13px;color:#888">
          {props.markCounts.total.toLocaleString('en')} marks stored.{' '}
          {props.markCounts.withNote.toLocaleString('en')} have the Note they federated
          with, so their visibility can be established.{' '}
          <strong style={props.markCounts.withoutNote > 0 ? 'color:#fbbf24' : ''}>
            {props.markCounts.withoutNote.toLocaleString('en')}
          </strong>{' '}
          do not, and are withheld — a mark without its Note is a mark we cannot prove
          was public.
        </p>
      </div>

      <h2>Sample of withheld posts</h2>
      <p style="color:#888;font-size:13px;margin-bottom:12px">
        Check that each of these genuinely should be withheld. The raw addressing is
        shown as stored.
      </p>
      <table style="margin-bottom:24px">
        <thead>
          <tr><th>Class</th><th>Published</th><th>Text</th><th>to</th><th>cc</th></tr>
        </thead>
        <tbody>
          {props.withheld.length === 0 ? <EmptyRow colspan={5} /> : null}
          {props.withheld.map((r) => (
            <tr>
              <td style={`color:${COLOUR[r.visibility] ?? '#888'}`}>{r.visibility}</td>
              <td style="color:#888;white-space:nowrap">
                {r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : '—'}
              </td>
              <td><Truncate text={r.contentText} /></td>
              <td style="font-family:monospace;font-size:11px;color:#888">
                <Truncate text={r.to} at={60} />
              </td>
              <td style="font-family:monospace;font-size:11px;color:#888">
                <Truncate text={r.cc} at={60} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Sample of posts that will be published</h2>
      <p style="color:#888;font-size:13px;margin-bottom:12px">
        Open a few at their origin and confirm they really are public there.
      </p>
      <table>
        <thead>
          <tr><th>Published</th><th>Text</th><th>Origin</th></tr>
        </thead>
        <tbody>
          {props.publishable.length === 0 ? <EmptyRow colspan={3} /> : null}
          {props.publishable.map((r) => (
            <tr>
              <td style="color:#888;white-space:nowrap">
                {r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : '—'}
              </td>
              <td><Truncate text={r.contentText} /></td>
              <td>
                {r.url ? <a href={r.url} target="_blank" rel="noopener">open ↗</a> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}
