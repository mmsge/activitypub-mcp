import { describe, it, expect } from 'vitest'
import { watchedQuery, otherQuery, scrobbleQuery } from './media-query.js'
import { buildQuery, withQuery } from './views/ui.js'

// These are rendered-SQL assertions, not DB round-trips (vitest has no database). They
// pin the two shapes that would fail silently: a Watched grid that quietly reverts to
// one-row-per-title, and an Other-media filter that hides never-enriched stubs.

describe('watched tab SQL', () => {
  it('is driven by neodb_marks, one row per viewing', () => {
    const { sql } = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('from "neodb_marks"')
    expect(sql).toContain('left join "catalog_metadata"')
  })

  // get_watched's markCommentsExpr / latestWatchedAtExpr are per-TITLE correlated
  // subqueries: on a per-viewing grid they would hand every row the item's whole history
  // (every comment, and the newest date rather than this viewing's). Reusing them would
  // still render, still return rows, and still look plausible — only the SQL catches it.
  it('does not reuse the per-title correlated expressions', () => {
    const { sql } = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).not.toContain('jsonb_agg(c.comment')
    expect(sql).not.toContain('select max(m.watched_at)')
    expect(sql).not.toContain('SELECT max(m.watched_at)')
  })

  // neodb_marks.category is nullable — older rows carry only the AP item type. Without
  // the coalesce onto the catalogue's category those marks vanish from every tab.
  it('resolves category across both tables', () => {
    const { sql } = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('coalesce("neodb_marks"."category", "catalog_metadata"."category")')
  })

  it('filters to film and TV only', () => {
    const { sql } = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain("in ('movie','tv')")
  })

  it('excludes tombstoned marks unless asked', () => {
    const visible = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL().sql
    expect(visible).toContain('"deleted_at" is null')
    const all = (watchedQuery({ showDeleted: true }, 0) as never as { toSQL(): { sql: string } }).toSQL().sql
    expect(all).not.toContain('"deleted_at" is null')
  })

  it('sorts by the shelf date by default, falling back to the mark date', () => {
    const { sql } = (watchedQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('coalesce("neodb_marks"."watched_at", "neodb_marks"."published_at") desc nulls last')
  })

  it('compares the watched range against the mark row directly, without an EXISTS', () => {
    const { sql } = (watchedQuery({ from: '2016-01-01', to: '2016-12-31' }, 0) as never as {
      toSQL(): { sql: string }
    }).toSQL()
    expect(sql).toContain('"neodb_marks"."watched_at" >=')
    expect(sql).toContain('"neodb_marks"."watched_at" <')
    expect(sql).not.toContain('exists (')
  })

  it('matches a title across the mark name, the catalogue title and the retained aliases', () => {
    const { sql } = (watchedQuery({ title: 'conflict' }, 0) as never as {
      toSQL(): { sql: string }
    }).toSQL()
    expect(sql).toContain('"neodb_marks"."title" ILIKE')
    expect(sql).toContain('"catalog_metadata"."title" ILIKE')
    expect(sql).toContain('jsonb_array_elements_text("catalog_metadata"."mark_titles")')
  })
})

describe('other media tab SQL', () => {
  // A catalogue row whose very first fetch failed has no category yet. A plain
  // `category NOT IN ('movie','tv')` is NULL-false, so those stubs would be missing from
  // the Watched tab AND the Other tab — invisible everywhere, which is exactly the
  // opposite of what the failed-enrichment view exists for.
  it('keeps never-enriched stubs whose category is still null', () => {
    const { sql } = (otherQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('"catalog_metadata"."category" is null')
    expect(sql).toContain("not in ('movie','tv')")
  })

  // One hash aggregate over neodb_marks, not two correlated subqueries per row — and it
  // leaves latest_at orderable, which a correlated subquery in the select list is not.
  it('rolls marks up with a grouped join', () => {
    const { sql } = (otherQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('GROUP BY item_url')
    expect(sql).toContain('mk.item_url = "catalog_metadata"."item_url"')
    expect(sql).toContain('left join (')
  })

  it('can order by the latest mark date', () => {
    const { sql } = (otherQuery({ sort: 'watched' }, 0) as never as {
      toSQL(): { sql: string }
    }).toSQL()
    expect(sql).toContain('mk.latest_at desc nulls last')
  })
})

describe('scrobbles rollup SQL', () => {
  it('groups by artist and album, picking the image off the newest play', () => {
    const { sql } = (scrobbleQuery({}, 0) as never as { toSQL(): { sql: string } }).toSQL()
    expect(sql).toContain('group by "scrobbles"."artist_name", "scrobbles"."album_name"')
    // Drizzle renders select-list column refs unqualified. Harmless here — scrobbles is
    // the only table in this query, so there is nothing for a bare name to bind to but
    // the intended column.
    expect(sql).toContain('(array_agg("image_url" ORDER BY "played_at" DESC))[1]')
  })
})

// The pagers these replaced spliced filter values straight into the href, so an actor URL
// carrying `&` or `#` truncated or corrupted the next page's filters — and the Logs pager
// omitted the filters entirely, silently resetting them on every page turn.
describe('pager query building', () => {
  it('encodes values that would otherwise break the query string', () => {
    const qs = buildQuery({ actor: 'https://x.social/@a?b=1&c=2#frag', q: 'two words' })
    expect(qs).not.toContain('#frag')
    expect(qs).toContain('%23frag')
    expect(qs).toContain('%26c%3D2')
    expect(new URLSearchParams(qs).get('actor')).toBe('https://x.social/@a?b=1&c=2#frag')
    expect(new URLSearchParams(qs).get('q')).toBe('two words')
  })

  it('carries filters through a page turn', () => {
    const href = withQuery('/admin/logs', { direction: 'inbound', sigValid: 'false', page: 2 })
    const params = new URL(href, 'https://example.test').searchParams
    expect(params.get('direction')).toBe('inbound')
    expect(params.get('sigValid')).toBe('false')
    expect(params.get('page')).toBe('2')
  })

  it('drops empty filters instead of emitting bare keys', () => {
    expect(buildQuery({ actor: '', type: undefined, page: 0 })).toBe('page=0')
  })
})
