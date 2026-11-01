import { desc } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { importRuns } from '../db/schema.js'
import { logger } from '../lib/logger.js'

// When each admin import last ran, and how it went (ADR 0073, phase 3).

export interface ImportRun {
  kind: string
  ranAt: Date
  ok: boolean
  summary: string | null
  error: string | null
}

/**
 * Record a finished run. Never throws: the run already happened, and a failed write of
 * its bookkeeping must not turn a good import into an error page.
 */
export async function recordImportRun(
  kind: string,
  outcome: { ok: true; summary: string } | { ok: false; error: string },
): Promise<void> {
  try {
    await getDb().insert(importRuns).values({
      kind,
      ok: outcome.ok,
      summary: outcome.ok ? outcome.summary : null,
      error: outcome.ok ? null : outcome.error.slice(0, 2000),
    })
  } catch (e) {
    logger.warn({ err: e, kind }, 'Could not record import run')
  }
}

/** The newest run of every kind that has one. */
export async function lastImportRuns(): Promise<Map<string, ImportRun>> {
  const rows = await getDb()
    .selectDistinctOn([importRuns.kind])
    .from(importRuns)
    .orderBy(importRuns.kind, desc(importRuns.ranAt))
  return new Map(rows.map((r) => [r.kind, {
    kind: r.kind, ranAt: r.ranAt, ok: r.ok, summary: r.summary, error: r.error,
  }]))
}
