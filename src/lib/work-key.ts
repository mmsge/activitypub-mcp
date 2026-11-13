/**
 * One work per title, whichever NeoDB instance marked it. See ADR 0075.
 *
 * `catalog_metadata` is keyed on the instance's catalogue URL, so the same season marked
 * on minreol.dk and again on neodb.social is two rows that never meet. `work_key` is the
 * column that says they are one work, and every read that should show one row per work
 * (`get_watched`, `get_catalogue_details`) groups on it.
 *
 * Two rows are the same work when they share a TMDB link, or an IMDb id when both are
 * films or both are whole shows. Nothing is merged on title alone.
 *
 * The season rule is the one not to "simplify" away. NeoDB often gives a TV season the
 * show's IMDb id, so an IMDb match on a season would fold season 1 into season 2 and both
 * into the show. A season therefore only ever matches on a TMDB link that names its own
 * season, and a show only on one that names no season.
 */

/** What a catalogue row looks like to the work-key logic. */
export interface WorkKeyRow {
  itemUrl: string
  category: string | null
  itemType: string | null
  tmdbUrl: string | null
  imdb: string | null
}

type Kind = 'movie' | 'show' | 'season' | 'other'

function kindOf(row: Pick<WorkKeyRow, 'category' | 'itemType'>): Kind {
  switch (row.itemType) {
    case 'Movie': return 'movie'
    case 'TVShow': return 'show'
    case 'TVSeason': return 'season'
    case 'TVEpisode': return 'other'
  }
  // No item type (a failure stub, or an older row): a `movie` category is unambiguous,
  // `tv` is not, since it covers shows, seasons and episodes alike.
  if (row.itemType == null && row.category === 'movie') return 'movie'
  return 'other'
}

const TMDB_PATH = /^\/(movie|tv)\/(\d+)(?:-[^/]*)?(?:\/season\/(\d+))?\/?$/

/**
 * A TMDB link, normalised to `tmdb:movie/<id>`, `tmdb:tv/<id>` or
 * `tmdb:tv/<id>/season/<n>`. Slugs, query strings, a trailing slash and the
 * `www.` host are dropped. Null for anything that is not a film, show or season page,
 * including an episode link.
 */
export function normaliseTmdbUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  const host = parsed.hostname.replace(/^www\./, '')
  if (host !== 'themoviedb.org') return null
  const m = TMDB_PATH.exec(parsed.pathname)
  if (!m) return null
  const [, type, id, season] = m
  if (type === 'movie') return season ? null : `tmdb:movie/${id}`
  return season != null ? `tmdb:tv/${id}/season/${Number(season)}` : `tmdb:tv/${id}`
}

/** The TMDB key this row may match on, after the kind check. */
export function tmdbKey(row: WorkKeyRow): string | null {
  const key = normaliseTmdbUrl(row.tmdbUrl)
  if (!key) return null
  const kind = kindOf(row)
  const isSeason = key.includes('/season/')
  if (kind === 'movie') return key.startsWith('tmdb:movie/') ? key : null
  if (kind === 'show') return key.startsWith('tmdb:tv/') && !isSeason ? key : null
  if (kind === 'season') return isSeason ? key : null
  // An item of no known kind still matches on a TMDB link, which names its own kind.
  return key
}

const IMDB_ID = /^tt\d+$/

/** The IMDb key this row may match on: films and whole shows only, never a season. */
export function imdbKey(row: WorkKeyRow): string | null {
  const id = row.imdb?.trim()
  if (!id || !IMDB_ID.test(id)) return null
  const kind = kindOf(row)
  if (kind === 'movie') return `imdb:movie/${id}`
  if (kind === 'show') return `imdb:tv/${id}`
  return null
}

/** The key a row has on its own, before it meets any other row. */
export function ownWorkKey(row: WorkKeyRow): string {
  return tmdbKey(row) ?? imdbKey(row) ?? `url:${row.itemUrl}`
}

/** Every key a row can be matched on. A row with none is its own work. */
export function matchKeys(row: WorkKeyRow): string[] {
  return [tmdbKey(row), imdbKey(row)].filter((k): k is string => k != null)
}

// tmdb sorts before imdb sorts before url, so a work is named by its TMDB link when it has
// one. Within a rank the lexically smallest key wins, which makes the choice depend on the
// set of rows and not on the order they were read in.
function rank(key: string): number {
  if (key.startsWith('tmdb:')) return 0
  if (key.startsWith('imdb:')) return 1
  return 2
}

export function preferKey(a: string, b: string): string {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra < rb ? a : b
  return a < b ? a : b
}

/**
 * Group rows into works and name each one. Returns `itemUrl → work_key` for every row.
 *
 * Union-find over the match keys, so a film with a TMDB link and an IMDb id joins a row
 * that has only the IMDb id, and that row in turn joins a third that has only the TMDB
 * link. Deterministic for a given set of rows: running it twice writes nothing the second
 * time, which is what makes the backfill safe to re-run.
 */
export function assignWorkKeys(rows: WorkKeyRow[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x) }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Nodes are item URLs and match keys alike, prefixed so they cannot collide.
  for (const row of rows) {
    const node = `row:${row.itemUrl}`
    add(node)
    for (const key of matchKeys(row)) {
      add(key)
      union(node, key)
    }
  }

  // Name each component by its best own key.
  const names = new Map<string, string>()
  for (const row of rows) {
    const root = find(`row:${row.itemUrl}`)
    const own = ownWorkKey(row)
    const current = names.get(root)
    names.set(root, current ? preferKey(current, own) : own)
  }

  const out = new Map<string, string>()
  for (const row of rows) out.set(row.itemUrl, names.get(find(`row:${row.itemUrl}`))!)
  return out
}
