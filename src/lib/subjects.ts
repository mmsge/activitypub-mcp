// Subject/genre tag cleanup. OpenLibrary (and BookWyrm editions imported from
// it) ship some subjects as raw prefixed tags — "genre:LitRPG",
// "series:Dungeon Crawler Carl" — alongside clean ones, so the same genre can
// appear both prefixed and bare. Normalization strips the known prefixes and
// dedups case-insensitively (first casing wins) so downstream grouping and
// filtering see one bucket per subject. Applied both when metadata is enriched
// (clean cache going forward) and when tools read the cache (already-stored
// rows are clean without a re-enrichment).

const SUBJECT_PREFIX = /^(genre|series|tag)\s*:\s*/i

export function normalizeSubjects(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const s = raw.replace(SUBJECT_PREFIX, '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.length ? out : null
}
