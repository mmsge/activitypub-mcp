import { describe, it, expect } from 'vitest'
import {
  getWatchedSchema,
  getCatalogueDetailsSchema,
  markCommentsExpr,
  markStatusesExpr,
  markStatusMatch,
  markStatusExcluded,
  latestMarkStatusExpr,
  latestMarkStatusRawExpr,
  markWatchedDatesExpr,
  latestWatchedAtExpr,
  parseWatchedBound,
  resolveWatchedWindow,
  watchedRangeMatch,
} from './watched.js'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getDb } from '../../db/client.js'
import { catalogMetadata } from '../../db/schema.js'
import { MARK_STATUS_MAP } from '../../lib/neodb-mark.js'

describe('mark_comments correlation', () => {
  // Drizzle qualifies a column reference in WHERE ("catalog_metadata"."item_url") but NOT
  // inside a select-list expression, where it renders a bare "item_url". In this subquery
  // that binds to neodb_marks' own column — an always-true self-comparison that silently
  // hands every catalogue row every comment in the table. It throws no error and the
  // response shape looks right, so only the rendered SQL catches a regression.
  it('correlates on catalog_metadata.item_url, table-qualified', () => {
    const { sql } = getDb()
      .select({ markComments: markCommentsExpr })
      .from(catalogMetadata)
      .toSQL()
    expect(sql).toContain('m.item_url = catalog_metadata.item_url')
    expect(sql).not.toMatch(/m\.item_url = "?item_url"?/)
  })
})

// Same trap as mark_comments: a bare `item_url` inside a select-list expression binds to
// neodb_marks' own column, turning the correlation into an always-true self-comparison —
// which would hand every catalogue row every watch date in the table.
describe('watch-date correlation', () => {
  it('correlates both watch-date expressions on catalog_metadata.item_url, table-qualified', () => {
    const { sql } = getDb()
      .select({ watchedDates: markWatchedDatesExpr, latestWatchedAt: latestWatchedAtExpr })
      .from(catalogMetadata)
      .toSQL()
    expect(sql).toContain('m.item_url = catalog_metadata.item_url')
    expect(sql).not.toMatch(/m\.item_url = "?item_url"?/)
  })

  it('excludes tombstoned marks and rows with no date from the dates array', () => {
    const { sql } = getDb().select({ watchedDates: markWatchedDatesExpr }).from(catalogMetadata).toSQL()
    expect(sql).toContain('m.deleted_at IS NULL')
    expect(sql).toContain('m.watched_at IS NOT NULL')
    // Newest first and duplicates collapsed, following mark_titles / mark_comments.
    expect(sql).toContain('SELECT DISTINCT m.watched_at')
    expect(sql).toContain('ORDER BY w.watched_at DESC')
  })

  it('takes the newest live mark as the scalar watched_at', () => {
    const { sql } = getDb().select({ latest: latestWatchedAtExpr }).from(catalogMetadata).toSQL()
    expect(sql).toContain('max(m.watched_at)')
    expect(sql).toContain('m.deleted_at IS NULL')
  })
})

describe('parseWatchedBound', () => {
  it('anchors a bare YYYY-MM-DD to UTC midnight on the from edge', () => {
    expect(parseWatchedBound('2016-01-01', 'from')).toMatchObject({ bare: true })
    expect(parseWatchedBound('2016-01-01', 'from')!.at.toISOString()).toBe('2016-01-01T00:00:00.000Z')
  })

  it('pushes a bare to-date to the following midnight so the whole day is covered', () => {
    // The bug this exists to prevent: watched_to=2016-12-31 taken literally as midnight
    // silently excludes everything actually watched on 31 December.
    expect(parseWatchedBound('2016-12-31', 'to')!.at.toISOString()).toBe('2017-01-01T00:00:00.000Z')
    expect(parseWatchedBound('2016-02-29', 'to')!.at.toISOString()).toBe('2016-03-01T00:00:00.000Z')
  })

  it('takes a full ISO timestamp at face value, flagged as not bare (so it stays inclusive)', () => {
    const b = parseWatchedBound('2016-02-09T12:00:00Z', 'to')!
    expect(b.bare).toBe(false)
    expect(b.at.toISOString()).toBe('2016-02-09T12:00:00.000Z')
    // minreol's own date picker sends this offset shape; it must parse, not be rejected.
    expect(parseWatchedBound('2016-02-09T22:00:00+00:53', 'from')!.at.toISOString())
      .toBe('2016-02-09T21:07:00.000Z')
  })

  it('is null for junk and for blank input', () => {
    expect(parseWatchedBound('not a date', 'from')).toBeNull()
    expect(parseWatchedBound('  ', 'from')).toBeNull()
  })
})

describe('resolveWatchedWindow', () => {
  it('expands watched_year into a full calendar year in UTC', () => {
    const { from, to } = resolveWatchedWindow({ watched_year: 2016 })
    expect(from!.at.toISOString()).toBe('2016-01-01T00:00:00.000Z')
    // 31 December included in full — the bound is the next midnight, exclusive.
    expect(to!.at.toISOString()).toBe('2017-01-01T00:00:00.000Z')
    expect(to!.bare).toBe(true)
  })

  it('lets an explicit bound override the year on its own edge only', () => {
    const { from, to } = resolveWatchedWindow({ watched_year: 2016, watched_from: '2016-06-01' })
    expect(from!.at.toISOString()).toBe('2016-06-01T00:00:00.000Z')
    expect(to!.at.toISOString()).toBe('2017-01-01T00:00:00.000Z')
  })

  it('is empty when no date filter is given, and one-sided when only one is', () => {
    expect(resolveWatchedWindow({})).toEqual({ from: null, to: null })
    const open = resolveWatchedWindow({ watched_from: '2016-01-01' })
    expect(open.from).not.toBeNull()
    expect(open.to).toBeNull()
  })
})

const dialect = new PgDialect()

describe('watchedRangeMatch', () => {
  it('matches per-mark, so a film watched in 2016 and again in 2020 answers both years', () => {
    const { from, to } = resolveWatchedWindow({ watched_year: 2016 })
    const { sql } = dialect.sqlToQuery(watchedRangeMatch(from, to))
    // EXISTS over the marks, not a comparison against the item's latest date.
    expect(sql).toContain('EXISTS')
    expect(sql).toContain('FROM neodb_marks m')
    expect(sql).toContain('m.deleted_at IS NULL')
  })

  it('binds the bounds as ISO strings and makes a bare to-date exclusive', () => {
    const { from, to } = resolveWatchedWindow({ watched_year: 2016 })
    const { sql, params } = dialect.sqlToQuery(watchedRangeMatch(from, to))
    // Same trap as the cursor: a Date inside a raw sql`` fragment reaches the driver as
    // its toString() form, which Postgres can't cast to timestamptz.
    for (const param of params) expect(typeof param).toBe('string')
    expect(params).toContain('2016-01-01T00:00:00.000Z')
    expect(params).toContain('2017-01-01T00:00:00.000Z')
    expect(sql).toContain('m.watched_at >=')
    expect(sql).toContain('m.watched_at <')
    expect(sql).not.toContain('m.watched_at <=')
  })

  it('keeps an explicit timestamp bound inclusive', () => {
    const { to } = resolveWatchedWindow({ watched_to: '2016-02-09T12:00:00Z' })
    const { sql } = dialect.sqlToQuery(watchedRangeMatch(null, to))
    expect(sql).toContain('m.watched_at <=')
  })

  it('renders a one-sided window with a single bound', () => {
    const { from } = resolveWatchedWindow({ watched_from: '2016-01-01' })
    const { sql, params } = dialect.sqlToQuery(watchedRangeMatch(from, null))
    expect(sql).toContain('m.watched_at >=')
    expect(sql).not.toContain('m.watched_at <')
    expect(params).toEqual(['2016-01-01T00:00:00.000Z'])
  })
})

describe('getWatchedSchema', () => {
  it('applies defaults for limit, page, sort_by, sort_order, and include_unenriched', () => {
    const parsed = getWatchedSchema.parse({})
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    // Additive: the existing fetched_at ordering stays the default.
    expect(parsed.sort_by).toBe('fetched_at')
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.include_unenriched).toBe(false)
    expect(parsed.title).toBeUndefined()
    expect(parsed.category).toBeUndefined()
    expect(parsed.item_type).toBeUndefined()
    expect(parsed.imdb).toBeUndefined()
    expect(parsed.cursor).toBeUndefined()
    expect(parsed.watched_from).toBeUndefined()
    expect(parsed.watched_to).toBeUndefined()
    expect(parsed.watched_year).toBeUndefined()
  })

  it('accepts the watch-date range, the year sugar, and sorting by the shelf date', () => {
    const parsed = getWatchedSchema.parse({
      watched_from: '2016-01-01', watched_to: '2016-12-31', sort_by: 'watched_at', sort_order: 'asc',
    })
    expect(parsed).toMatchObject({
      watched_from: '2016-01-01', watched_to: '2016-12-31', sort_by: 'watched_at', sort_order: 'asc',
    })
    expect(getWatchedSchema.parse({ watched_year: 2016 }).watched_year).toBe(2016)
    expect(getWatchedSchema.parse({ watched_to: '2016-02-09T12:00:00Z' }).watched_to)
      .toBe('2016-02-09T12:00:00Z')
  })

  it('rejects an unparseable date bound, an out-of-range year, and an unknown sort_by', () => {
    expect(() => getWatchedSchema.parse({ watched_from: 'last tuesday' })).toThrow()
    expect(() => getWatchedSchema.parse({ watched_to: '' })).toThrow()
    expect(() => getWatchedSchema.parse({ watched_year: 16 })).toThrow()
    expect(() => getWatchedSchema.parse({ watched_year: 2016.5 })).toThrow()
    expect(() => getWatchedSchema.parse({ sort_by: 'published_at' })).toThrow()
  })

  it('accepts all optional filters', () => {
    const parsed = getWatchedSchema.parse({
      title: 'conflict',
      category: 'tv',
      item_type: 'TVSeason',
      genre: 'thriller',
      imdb: 'tt27579939',
      mark_comment: 'kino',
      sort_order: 'asc',
      cursor: 'tok',
    })
    expect(parsed).toMatchObject({
      title: 'conflict',
      category: 'tv',
      item_type: 'TVSeason',
      genre: 'thriller',
      imdb: 'tt27579939',
      mark_comment: 'kino',
      sort_order: 'asc',
      cursor: 'tok',
    })
  })

  it('leaves mark_comment unset by default and takes it verbatim — no parsing, no trimming', () => {
    expect(getWatchedSchema.parse({}).mark_comment).toBeUndefined()
    // The comments are Nynorsk prose, full stop included; the filter must not
    // normalise what it is handed.
    expect(getWatchedSchema.parse({ mark_comment: 'Sett på kino.' }).mark_comment).toBe('Sett på kino.')
  })

  it('enforces limit bounds (1..200)', () => {
    expect(getWatchedSchema.parse({ limit: 200 }).limit).toBe(200)
    expect(() => getWatchedSchema.parse({ limit: 0 })).toThrow()
    expect(() => getWatchedSchema.parse({ limit: 201 })).toThrow()
  })

  it('rejects page below 1 and an unknown sort_order', () => {
    expect(() => getWatchedSchema.parse({ page: 0 })).toThrow()
    expect(() => getWatchedSchema.parse({ sort_order: 'sideways' })).toThrow()
  })
})

describe('getCatalogueDetailsSchema', () => {
  it('accepts item_url, title, and category', () => {
    const parsed = getCatalogueDetailsSchema.parse({
      item_url: 'https://minreol.dk/album/abc', title: 'abbey', category: 'music',
    })
    expect(parsed).toMatchObject({
      item_url: 'https://minreol.dk/album/abc', title: 'abbey', category: 'music',
    })
  })

  it('allows an empty object (handler validates that at least one selector is set)', () => {
    expect(() => getCatalogueDetailsSchema.parse({})).not.toThrow()
  })
})


describe('the mark status filters', () => {
  const render = (x: unknown) => new PgDialect().sqlToQuery(x as never).sql

  it('correlates on a table-qualified item_url, not a bare one', () => {
    // A bare `item_url` inside these subqueries binds to neodb_marks' own column —
    // an always-true self-comparison that hands every row every mark in the table.
    // The same trap markCommentsExpr documents.
    for (const expr of [markStatusesExpr, latestMarkStatusExpr, latestMarkStatusRawExpr]) {
      expect(render(expr)).toContain('m.item_url = catalog_metadata.item_url')
      expect(render(expr)).toContain('m.deleted_at IS NULL')
    }
  })

  it('takes the newest mark, so a re-mark supersedes the one before it', () => {
    // "progress" becomes "complete" by being marked again; the scalar must follow.
    for (const expr of [latestMarkStatusExpr, latestMarkStatusRawExpr]) {
      expect(render(expr)).toContain('ORDER BY m.published_at DESC NULLS LAST')
      expect(render(expr)).toContain('LIMIT 1')
    }
  })

  it('accepts the four canonical statuses and rejects anything else', () => {
    for (const status of ['wishlist', 'progress', 'complete', 'dropped']) {
      expect(getWatchedSchema.parse({ status }).status).toBe(status)
    }
    expect(() => getWatchedSchema.parse({ status: 'abandoned' })).toThrow()
    expect(() => getWatchedSchema.parse({ status: 'read' })).toThrow()
  })

  it('takes exclude_status as a list and leaves both filters off by default', () => {
    expect(getWatchedSchema.parse({ exclude_status: ['dropped', 'progress'] }).exclude_status)
      .toEqual(['dropped', 'progress'])
    const bare = getWatchedSchema.parse({})
    expect(bare.status).toBeUndefined()
    expect(bare.exclude_status).toBeUndefined()
  })

  it('keeps the four canonical statuses in step with what the parser can produce', () => {
    // If NeoDB adds a verb and mapMarkStatus learns it, the filter enum has to learn
    // it too, or it lands in the database and becomes unfilterable — which is the
    // state `dropped` itself was in until this change.
    const filterable = ['wishlist', 'progress', 'complete', 'dropped'].sort()
    expect(Object.keys(MARK_STATUS_MAP).sort()).toEqual(filterable)
  })
})


describe('the status predicates render as valid SQL', () => {
  // These are the tests that were missing. The suite above rendered the select-list
  // *expressions* and parsed the schema, and both passed while `exclude_status`
  // returned 500 on every call — because nothing rendered the WHERE predicate the
  // filter actually builds.
  const render = (x: unknown) => new PgDialect().sqlToQuery(x as never)

  it('excludes with NOT IN, against the placeholder list Drizzle actually emits', () => {
    // Drizzle renders an embedded JS array as `($1, $2)` — parens included. That is
    // the shape IN wants. `<> ALL (...)` wants an array expression, so adding the
    // parens ALL needs produces `ALL (($1, $2))`, a row constructor, and Postgres
    // rejects the statement. This assertion is the whole point of the test.
    const q = render(markStatusExcluded(['dropped', 'progress']))
    expect(q.sql).toContain('NOT IN ($1, $2)')
    expect(q.sql).not.toContain('ALL')
    expect(q.sql).not.toContain('(($1')
    expect(q.params).toEqual(['dropped', 'progress'])
  })

  it('keeps an item with no tracked mark, via the coalesce to empty string', () => {
    // The negative filter's entire reason for existing: absence of a mark means
    // "we do not know", and '' matches nothing in the exclusion list, so it stays.
    const q = render(markStatusExcluded(['dropped']))
    expect(q.sql).toContain("coalesce(")
    expect(q.sql).toContain("''")
  })

  it('matches positively on the newest mark', () => {
    const q = render(markStatusMatch('complete'))
    expect(q.sql).toContain('ORDER BY m.published_at DESC NULLS LAST')
    expect(q.sql).toContain('LIMIT 1')
    expect(q.params).toEqual(['complete'])
  })

  it('correlates both predicates table-qualified', () => {
    for (const p of [markStatusMatch('complete'), markStatusExcluded(['dropped'])]) {
      expect(render(p).sql).toContain('"catalog_metadata"."item_url"')
    }
  })
})
