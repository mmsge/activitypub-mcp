/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import type { TokenStatus } from '../../lib/source-health.js'

// Shared building blocks for the admin tables. Every list page hand-rolled its own
// pager, empty row and badge logic; the Media page would have made that a seventh
// copy, so they live here instead.

export type QueryParams = Record<string, string | number | undefined | null>

/**
 * Build a query string from a filter bag, dropping empties.
 *
 * Uses URLSearchParams rather than template interpolation on purpose: the pagers this
 * replaces spliced filter values straight into the href, so an actor URL containing
 * `&` or `#` silently truncated or corrupted the next page's filters.
 */
export function buildQuery(params: QueryParams): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  return sp.toString()
}

export function withQuery(base: string, params: QueryParams): string {
  const qs = buildQuery(params)
  return qs ? `${base}?${qs}` : base
}

/**
 * Offset pager. `params` carries the current filters so they survive a page turn —
 * the Logs pager used to drop them entirely, silently resetting direction/sigValid/actor
 * the moment you clicked Next.
 */
export const Pager: FC<{
  base: string
  page: number
  hasMore: boolean
  params?: QueryParams
}> = ({ base, page, hasMore, params = {} }) => {
  if (page <= 0 && !hasMore) return null
  return (
    <div style="display:flex;gap:12px;margin-top:16px">
      {page > 0 && (
        <a href={withQuery(base, { ...params, page: page - 1 })} class="btn">← Previous</a>
      )}
      {hasMore && (
        <a href={withQuery(base, { ...params, page: page + 1 })} class="btn">Next →</a>
      )}
    </div>
  )
}

export const EmptyRow: FC<{ colspan: number; text?: string }> = ({ colspan, text }) => (
  <tr>
    <td colspan={colspan} style="color:#666;text-align:center">{text ?? 'Nothing found'}</td>
  </tr>
)

/**
 * Ingest health for a polled source, from `source_sync_state`.
 *
 * The sibling of EnrichBadge, and it splits the same way for the same reason: a
 * source can hold perfectly good data *and* a failing refresh. That is "stale",
 * not "failed" — the LinkedIn snapshot stays valid long after the hand-minted
 * token that fetched it dies, so calling it failed would suggest the numbers are
 * untrustworthy when the real problem is that they have stopped moving.
 *
 * "Awaiting data" is the fifth state and the one that is easiest to get wrong: the
 * poller is succeeding and has simply never been given anything, because LinkedIn
 * collates the snapshot's activity domains after its profile ones. Showing that as
 * green OK is what sent someone to a curl loop to find out why the archive was
 * empty. It is deliberately NOT yellow — yellow is Stale, which means the opposite
 * (the job has stopped) — and blue already reads as "nothing yet" on EnrichBadge.
 *
 * This tile is the answer to "a stale or expired token must be visible without
 * reading logs". See ADR 0033, amended by 0034.
 */
export const SourceBadge: FC<{
  status: TokenStatus
  lastError?: string | null
  lastSuccessAt?: Date | null
  lastDataAt?: Date | null
}> = ({ status, lastError, lastSuccessAt, lastDataAt }) => {
  const since = lastSuccessAt ? `Last success: ${lastSuccessAt.toISOString()}` : 'Never succeeded'
  if (status === 'ok') {
    const data = lastDataAt ? ` · Data last arrived: ${lastDataAt.toISOString()}` : ''
    return <span class="badge badge-green" title={`${since}${data}`}>OK</span>
  }
  if (status === 'awaiting_data') {
    return (
      <span class="badge badge-blue" title={`${since} · no rows returned yet`}>
        Awaiting data
      </span>
    )
  }
  if (status === 'stale') {
    return <span class="badge badge-yellow" title={`${since}${lastError ? ` · ${lastError}` : ''}`}>Stale</span>
  }
  if (status === 'unauthorized') {
    return (
      <span class="badge badge-red" title={`${since}${lastError ? ` · ${lastError}` : ''}`}>
        Token refused
      </span>
    )
  }
  return <span class="badge badge-blue">Never run</span>
}
