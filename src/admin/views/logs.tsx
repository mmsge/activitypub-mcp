/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { Layout } from './layout.js'
import { withQuery } from './ui.js'
import { actorHandle } from '../attention.js'

// Loggar, from the mobile handoff (ADR 0073, phase 4): filter chips, one card per HTTP
// request, tap a card for its error and body. The list polls itself every 10 s, and
// holds still while a card is open so a body being read is not swapped away.

export interface LogEntry {
  id: number
  direction: string
  method: string
  url: string
  responseStatus: number | null
  signatureValid: boolean | null
  error: string | null
  actorApId: string | null
  createdAt: Date
  requestBody: string | null
  requestHeaders: unknown
  responseBody: string | null
}

export type LogFilter = 'alle' | 'inn' | 'ut' | 'feil' | 'ugyldig'

export const LOG_FILTERS: Array<[LogFilter, string]> = [
  ['alle', 'Alle'],
  ['inn', 'Inn'],
  ['ut', 'Ut'],
  ['feil', 'Feil'],
  ['ugyldig', 'Ugyldig signatur'],
]

/**
 * The chip a request asks for. `f` is the new parameter; the old `direction` and
 * `sigValid` ones still work, so a bookmarked or linked filter keeps its meaning.
 */
export function logFilterOf(q: { f?: string; direction?: string; sigValid?: string }): LogFilter {
  if (q.f && LOG_FILTERS.some(([id]) => id === q.f)) return q.f as LogFilter
  if (q.sigValid === 'false') return 'ugyldig'
  if (q.direction === 'inbound') return 'inn'
  if (q.direction === 'outbound') return 'ut'
  return 'alle'
}

interface LogsPageProps {
  logs: LogEntry[]
  page: number
  hasMore: boolean
  filter: LogFilter
  actor?: string
  now?: Date
}

const params = (filter: LogFilter, actor?: string) => ({ f: filter === 'alle' ? undefined : filter, actor })

export function LogsPage({ logs, page, hasMore, filter, actor, now }: LogsPageProps) {
  return (
    <Layout title="Loggar" nav="loggar" live>
      <div class="stack logs">
        <nav class="tabs" aria-label="Filter">
          {LOG_FILTERS.map(([id, label]) => (
            <a href={withQuery('/admin/logs', params(id, actor))} class={id === filter ? 'active' : ''}
              aria-current={id === filter ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        {actor && (
          <div class="actor-filter">
            <span class="mono">{actorHandle(actor)}</span>
            <a href={withQuery('/admin/logs', params(filter))} aria-label="Fjern aktørfilteret">✕</a>
          </div>
        )}
        {/* Polls the fragment route, which re-renders exactly these cards for the current
            page and filter. The trigger filter skips a tick while any card is open. */}
        <div
          id="log-rows"
          class="log-list"
          hx-get={withQuery('/admin/logs/rows', { ...params(filter, actor), page: page || undefined })}
          hx-trigger="every 10s [!document.querySelector('#log-rows details[open]')]"
          hx-swap="innerHTML"
        >
          <LogRows logs={logs} now={now} />
        </div>
        {(page > 0 || hasMore) && (
          <div class="panel">
            <div class="more">
              {page > 0 && <a href={withQuery('/admin/logs', { ...params(filter, actor), page: page - 1 })}>‹ Nyare</a>}
              {hasMore && <a class="more-next" href={withQuery('/admin/logs', { ...params(filter, actor), page: page + 1 })}>Eldre ›</a>}
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}

/** The cards on their own, so the poll can swap them in without a page reload. */
export function LogRows({ logs, now }: { logs: LogEntry[]; now?: Date }) {
  if (logs.length === 0) {
    return <div class="empty-box">Ingen førespurnader med dette filteret.</div>
  }
  return <>{logs.map((l) => <LogCard log={l} now={now} />)}</>
}

const OSLO_DAY = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' })

/** "10:21:07" today, "31. okt. 10:21" before that, in Oslo time. */
export function logTime(d: Date, now = new Date()): string {
  const time = d.toLocaleTimeString('nn-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (OSLO_DAY(d) === OSLO_DAY(now)) return time
  const day = d.toLocaleDateString('nn-NO', { timeZone: 'Europe/Oslo', day: 'numeric', month: 'short' })
  return `${day} ${time.slice(0, 5)}`
}

const LogCard: FC<{ log: LogEntry; now?: Date }> = ({ log: l, now }) => {
  const failed = (l.responseStatus ?? 0) >= 400
  const body = [
    l.requestBody ? l.requestBody.slice(0, 2000) : null,
    l.responseBody ? `Svar:\n${l.responseBody.slice(0, 1000)}` : null,
  ].filter(Boolean).join('\n\n')
  return (
    <details class="log-card">
      <summary>
        <div class="log-top">
          {l.direction === 'inbound'
            ? <span class="badge badge-blue">INN</span>
            : <span class="badge badge-yellow">UT</span>}
          <span class="mono log-method">{l.method}</span>
          <span class={`mono log-status${failed ? ' tone-red' : ''}`}>{l.responseStatus ?? '—'}</span>
          {l.signatureValid !== null && (
            <span class={l.signatureValid ? 'tone-green' : 'tone-red'} title={l.signatureValid ? 'Gyldig signatur' : 'Ugyldig signatur'}>
              {l.signatureValid ? '✓' : '✗'}
            </span>
          )}
          <span class="mono log-time" title={l.createdAt.toISOString()}>{logTime(l.createdAt, now)}</span>
        </div>
        <div class="mono log-url">{l.url}</div>
        {l.actorApId && <div class="log-actor">{actorHandle(l.actorApId)}</div>}
      </summary>
      <div class="log-detail">
        {l.error && <div class="log-error">{l.error}</div>}
        <pre>{body || '(ingen body)'}</pre>
      </div>
    </details>
  )
}
