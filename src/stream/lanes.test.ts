import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  postsLane, readingLane, marksLane, gigsLane, musicLane, tripsLane, gardenLane,
  mergedCandidateSql, type LaneContext,
} from './lanes.js'
import { EMPTY_FACETS, type Facets } from './facets.js'
import { AP_PLATFORMS, platformInfo } from './sources.js'
import { encodeCursor } from '../mcp/tools/pagination.js'

const dialect = new PgDialect()
const render = (s: SQL | null): string => (s == null ? '' : dialect.sqlToQuery(s).sql)

/**
 * The same query, with the values bound into it appended.
 *
 * The patterns a reading lane selects on ('%/review/%', 'started reading') are bound
 * parameters, not inline literals. A test that read `.sql` alone would see `$7` and
 * happily pass whatever the lane actually matched, so anything asserting *what* is
 * selected has to look here. Anything asserting the query's shape wants `render` —
 * this string does not end where the SQL does.
 */
const renderBound = (s: SQL | null): string => {
  if (s == null) return ''
  const q = dialect.sqlToQuery(s)
  return `${q.sql}\n-- params: ${JSON.stringify(q.params)}`
}

const ACTOR_IDS = {
  mastodon: ['https://skvip.lol/users/markus'],
  pixelfed: ['https://pixelfed.babb.no/users/markus'],
  loops: ['https://loops.video/ap/users/79185548970954752'],
  bookwyrm: ['https://bookwyrm.social/user/mvrkws'],
  neodb: ['https://minreol.dk/@markus@minreol.dk/'],
  rullen: ['https://rullen.no/users/markus'],
  samklang: ['https://samklang.msge.no/brukar/markus'],
}

const ctx = (facets: Partial<Facets> = {}): LaneContext => ({
  facets: { ...EMPTY_FACETS, ...facets },
  actorIds: ACTOR_IDS,
  limit: 20,
})

// The lanes that read from `objects` and therefore carry a visibility verdict.
const VISIBILITY_LANES: Array<[string, (c: LaneContext) => SQL | null]> = [
  ['posts', postsLane],
  ['reading', readingLane],
  ['marks', marksLane],
  ['gigs', gigsLane],
]

describe('every lane that touches objects filters on visibility', () => {
  // The single assertion this whole feature rests on. A lane that forgets it
  // publishes followers-only posts.
  for (const [name, build] of VISIBILITY_LANES) {
    it(`${name} restricts to public, qualified by its own alias`, () => {
      const sql = render(build(ctx()))
      expect(sql).toContain("o.visibility = 'public'")
    })

    it(`${name} excludes soft-deleted rows`, () => {
      expect(render(build(ctx()))).toMatch(/deleted_at IS NULL/i)
    })
  }
})

describe('postsLane', () => {
  it('scopes to the allowlisted accounts, never to all of objects', () => {
    // `objects` also holds strangers' posts, filed there by the boost handler.
    const sql = render(postsLane(ctx()))
    expect(sql).toContain('o.actor_ap_id = ANY(')
  })

  it('yields nothing at all when no account is configured', () => {
    expect(postsLane({
      ...ctx(),
      actorIds: { ...ACTOR_IDS, mastodon: [], pixelfed: [], loops: [], rullen: [], samklang: [] },
    })).toBeNull()
  })

  it('takes only thread roots as entries', () => {
    expect(render(postsLane(ctx()))).toContain('o.in_reply_to IS NULL')
  })

  it('recognises a self-thread continuation as publishable', () => {
    // The EXISTS arm is what keeps Markus' own threads together; it must itself
    // be visibility-filtered, or a public root could pull in a private reply.
    const sql = render(postsLane(ctx()))
    expect(sql).toContain('p.actor_ap_id = o.actor_ap_id')
    // Two checks: the row itself, and the parent it continues.
    expect(sql.match(/\bvisibility = 'public'/g)?.length).toBe(2)
  })

  // Regression guard: the badge used to come from `coalesce(actors.software, …)`,
  // the value a remote server reports about itself. Markus' own server reports
  // "rullen"; anything the view's registry does not know renders as undefined and
  // takes the page down. STREAM_SOURCES is the source of truth for what an account
  // is, so the badge is built from the configured platform instead.
  it('labels each post from its configured platform, not from actors.software', () => {
    const sql = render(postsLane(ctx()))
    expect(sql).not.toContain('a.software')
    expect(sql).not.toContain('LEFT JOIN actors')
    expect(sql).toContain('CASE WHEN o.actor_ap_id = ANY(')
  })

  // Read off the registry, so a platform added to AP_PLATFORMS but left out of the
  // lane fails here rather than silently serving nothing under its own badge.
  it('carries every posts-lane platform', () => {
    const { params } = dialect.sqlToQuery(postsLane(ctx())!)
    for (const p of AP_PLATFORMS.filter((x) => platformInfo(x).lane === 'posts')) {
      expect(params, p).toContain(p)
      for (const id of ACTOR_IDS[p]) expect(params, id).toContain(id)
    }
  })

  // Regression: four platforms share this lane, so selecting the lane is not the
  // same as selecting the platform. Before this, /kjelde/rullen returned twenty
  // Mastodon posts — identical to /kjelde/mastodon and /kjelde/pixelfed.
  it('narrows to the selected platform\'s accounts, not just to the lane', () => {
    const { params } = dialect.sqlToQuery(postsLane(ctx({ platform: 'rullen' }))!)
    expect(params).toContain('https://rullen.no/users/markus')
    expect(params).not.toContain('https://skvip.lol/users/markus')
    expect(params).not.toContain('https://pixelfed.babb.no/users/markus')
  })

  it('carries every posts-lane account when unfiltered', () => {
    const { params } = dialect.sqlToQuery(postsLane(ctx())!)
    for (const id of Object.values(ACTOR_IDS).flat()) {
      // The three accounts that own a lane of their own: BookWyrm reads as reading,
      // NeoDB as marks, and Gigowl as gigs. A posts lane that swept any of them in
      // would publish the same event twice in the merge.
      if (id.includes('bookwyrm') || id.includes('minreol') || id.includes('samklang')) continue
      expect(params, id).toContain(id)
    }
  })

  it('yields nothing for a platform whose account is not configured', () => {
    expect(postsLane({ ...ctx({ platform: 'loops' }), actorIds: { ...ACTOR_IDS, loops: [] } }))
      .toBeNull()
  })

  it('requires a published date, so event_at is never null', () => {
    expect(render(postsLane(ctx()))).toContain('o.published_at IS NOT NULL')
  })
})

describe('readingLane', () => {
  it('keeps every kind of reading event BookWyrm emits', () => {
    const sql = renderBound(readingLane(ctx()))
    expect(sql).toContain('/review/')
    expect(sql).toContain('/quotation/')
    expect(sql).toContain('/reviewrating/')
    expect(sql).toContain('started reading')
    expect(sql).toContain('finished reading')
  })

  it('selects comments, because a start can arrive as one', () => {
    // The bug this lane was fixed for: flipping a shelf *with text* makes BookWyrm
    // emit no generatednote at all, only a comment carrying readingStatus. Dropping
    // comments dropped real starts and finishes, not progress notes.
    const sql = renderBound(readingLane(ctx()))
    expect(sql).toContain('/comment/')
    expect(sql).toContain("readingStatus")
  })

  it('leaves want-to-read out, in either shape it arrives in', () => {
    // Intent is not activity — the same call as NeoDB wishlists. It reaches us as a
    // generatednote saying so, or as a comment shelved to-read.
    const sql = renderBound(readingLane(ctx()))
    expect(sql).toContain('wants to read')
    expect(sql).toContain('%to-read%')
  })

  it('collapses a bare start note into the comment that says it in words', () => {
    // BookWyrm can emit both for one shelf flip. Done in SQL, not afterwards: every
    // lane carries its own LIMIT, so dropping rows later would return short pages.
    const sql = renderBound(readingLane(ctx()))
    expect(sql).toContain('NOT (o.ap_id LIKE')
    expect(sql).toContain('EXISTS (')
    expect(sql).toContain("date_trunc('day', c.published_at AT TIME ZONE 'Europe/Oslo')")
  })

  it('holds the suppressing comment to the same visibility gate', () => {
    // A followers-only comment may not delete a public note from the page.
    expect(renderBound(readingLane(ctx()))).toContain("c.visibility = 'public'")
  })

  it('dates a finish by the reader\'s own finish date where BookWyrm carried one', () => {
    expect(renderBound(readingLane(ctx()))).toContain("'finishedDate'")
  })

  for (const kind of ['book_started', 'book_finished', 'book_comment', 'book_review', 'book_quote'] as const) {
    it(`narrows to ${kind} for /type/${kind}`, () => {
      // `?? sql\`false\`` is the fallback for a kind this lane cannot serve, so an
      // empty narrowing here would silently render an empty page instead.
      const sql = renderBound(readingLane(ctx({ kind })))
      expect(sql).not.toContain('false')
      expect(sql.length).toBeGreaterThan(renderBound(readingLane(ctx())).length)
    })
  }
})

describe('marksLane', () => {
  it('joins objects with an INNER join, not a LEFT join', () => {
    // A mark's visibility lives on the Note it federated with. Without the Note
    // there is no proof it was public, and a LEFT JOIN would publish it anyway.
    const sql = render(marksLane(ctx()))
    expect(sql).toMatch(/JOIN objects o ON o\.ap_id = m\.mark_ap_id/)
    expect(sql).not.toMatch(/LEFT JOIN objects/)
  })

  it('excludes hidden catalogue rows (ADR 0013)', () => {
    expect(render(marksLane(ctx()))).toContain('cm.hidden_at IS NULL')
  })

  it('excludes wishlist marks — intent is not activity', () => {
    expect(render(marksLane(ctx()))).toContain("m.status IS DISTINCT FROM 'wishlist'")
  })

  it('prefers the shelf date over the post date (ADR 0012)', () => {
    expect(render(marksLane(ctx()))).toContain('coalesce(m.watched_at, m.published_at)')
  })
})

describe('gigsLane', () => {
  it('dates a gig by the night it happened, not by when it was logged', () => {
    // The whole reason this lane exists. Gigowl stamps an attendance Note with the
    // attendance's updatedAt, so ordering on the post date would bury a decade of
    // concerts under the afternoon the archive was typed up.
    const sql = render(gigsLane(ctx()))
    expect(sql).toContain('g.gig_date::timestamptz')
    expect(sql).not.toContain('a.published_at AS event_at')
  })

  it('joins objects with an INNER join, not a LEFT join', () => {
    // Same rule as marksLane: the attendance's visibility lives on the Note it
    // federated with, and without the Note there is no proof it was public.
    const sql = render(gigsLane(ctx()))
    expect(sql).toMatch(/JOIN objects o ON o\.ap_id = a\.note_ap_id/)
    expect(sql).not.toMatch(/LEFT JOIN objects/)
  })

  it('excludes hidden gigs (ADR 0013)', () => {
    expect(render(gigsLane(ctx()))).toContain('g.hidden_at IS NULL')
  })

  it('excludes gigs only fancied — intent is not activity', () => {
    expect(render(gigsLane(ctx()))).toContain("a.status IS DISTINCT FROM 'interested'")
  })

  it('skips a gig with no date rather than placing it at the epoch', () => {
    expect(render(gigsLane(ctx()))).toContain('g.gig_date IS NOT NULL')
  })

  it('yields nothing when the concert log is not configured', () => {
    expect(gigsLane({ ...ctx(), actorIds: { ...ACTOR_IDS, samklang: [] } })).toBeNull()
  })
})

describe('musicLane', () => {
  it('groups by the Oslo day, not the UTC day', () => {
    const sql = render(musicLane(ctx()))
    expect(sql).toContain("AT TIME ZONE 'Europe/Oslo'")
  })

  it('bounds the scan on the indexed column, so the GROUP BY reads a range', () => {
    // Without this the digest lane sorts the whole 51k-row history per request.
    expect(render(musicLane(ctx()))).toMatch(/s\.played_at >= now\(\) - /)
  })

  it('narrows the scan further when paging', () => {
    const cursor = encodeCursor(new Date('2026-06-01T00:00:00Z'), 'scrobbleday:2026-06-01')
    expect(render(musicLane(ctx({ cursor })))).toMatch(/s\.played_at < .*interval '2 days'/)
  })

  it('sits out a hashtag filter — scrobbles carry no tags', () => {
    expect(musicLane(ctx({ tag: 'togselfie' }))).toBeNull()
  })

  it('sits out a kind filter that is not its own', () => {
    expect(musicLane(ctx({ kind: 'book_review' }))).toBeNull()
    expect(musicLane(ctx({ kind: 'scrobble_day' }))).not.toBeNull()
  })
})

describe('gardenLane', () => {
  it('excludes undated notes rather than placing them at the epoch', () => {
    const sql = render(gardenLane(ctx()))
    expect(sql).toContain('g.note_date ~')
  })

  it('guards the cast, so one malformed hand-written date cannot error the page', () => {
    const sql = render(gardenLane(ctx()))
    expect(sql).toMatch(/note_date ~ '\^\\d\{4\}\(-\\d\{2\}/)
  })

  it('excludes soft-deleted notes', () => {
    expect(render(gardenLane(ctx()))).toContain('g.deleted_at IS NULL')
  })
})

describe('every lane', () => {
  const ALL: Array<[string, (c: LaneContext) => SQL | null]> = [
    ['posts', postsLane], ['reading', readingLane], ['marks', marksLane],
    ['music', musicLane], ['trips', tripsLane], ['garden', gardenLane],
  ]

  it('orders identically, with the C collation on the tiebreaker', () => {
    // The per-lane ORDER BY, the merge ORDER BY and the keyset comparison must
    // agree exactly, or a page boundary lands where the cursor does not expect it.
    for (const [name, build] of ALL) {
      const sql = render(build(ctx()))
      expect(sql, name).toMatch(/ORDER BY .+ DESC, \(.+\) COLLATE "C" DESC/s)
    }
  })

  // Regression: `ORDER BY ref_id` is legal (a bare output-column name), but
  // `ORDER BY ref_id COLLATE "C"` is not — wrapping the alias in an expression
  // makes Postgres resolve it against the input columns, and every request 500'd
  // with `column "ref_id" does not exist`.
  it('orders on the expressions, never on the output aliases', () => {
    for (const [name, build] of ALL) {
      const sql = render(build(ctx()))
      const orderBy = sql.slice(sql.lastIndexOf('ORDER BY'))
      expect(orderBy, name).not.toMatch(/\bref_id\b/)
      expect(orderBy, name).not.toMatch(/\bevent_at\b/)
    }
  })

  // Regression: the shared conditions are built with drizzle and render
  // `"objects"."visibility"`, which does not resolve inside `FROM objects o` —
  // and in the self-thread subquery would have silently checked the wrong row.
  it('refers to its own aliases, never to the bare table name', () => {
    for (const [name, build] of ALL) {
      expect(render(build(ctx({ kind: 'book_review' }))), name).not.toContain('"objects".')
      expect(render(build(ctx())), name).not.toContain('"objects".')
    }
  })

  it('checks the parent post\'s own visibility when keeping a self-thread', () => {
    // `publicOnlyOn('o', …)` here would have resolved to the outer row, letting a
    // public root pull in a private reply.
    const sql = render(postsLane(ctx()))
    expect(sql).toContain("p.visibility = 'public'")
  })

  it('limits itself, so the merge never materialises a whole table', () => {
    for (const [name, build] of ALL) {
      expect(render(build(ctx())), name).toMatch(/LIMIT \$\d+\s*$/)
    }
  })

  it('applies the keyset when a cursor is present', () => {
    const cursor = encodeCursor(new Date('2026-06-01T00:00:00Z'), 'post:abc')
    for (const [name, build] of ALL) {
      expect(render(build(ctx({ cursor }))), name).toContain('COLLATE "C" <')
    }
  })

  // Regression: the viaduct.world import carries *planned* journeys, and the stream
  // is ordered by event date — so three months of trips Markus had not taken were
  // sorting above everything real and filling the front page.
  it('excludes anything that has not happened yet', () => {
    for (const [name, build] of ALL) {
      expect(render(build(ctx())), name).toContain('<= now()')
    }
  })

  it('applies the archive bound', () => {
    for (const [name, build] of ALL) {
      const sql = render(build(ctx({ year: 2026, month: 8 })))
      expect(sql, name).toMatch(/timestamptz/)
    }
  })

  it('emits exactly the four merge columns', () => {
    for (const [name, build] of ALL) {
      const sql = render(build(ctx()))
      expect(sql, name).toContain('AS event_at')
      expect(sql, name).toContain('AS kind')
      expect(sql, name).toContain('AS ref_id')
      expect(sql, name).toContain('AS source')
    }
  })
})

describe('mergedCandidateSql', () => {
  it('unions every lane when unfiltered', () => {
    const sql = render(mergedCandidateSql(ctx()))
    expect(sql.match(/UNION ALL/g)?.length).toBe(6) // seven lanes, six joins
  })

  // Regression: a lane carries its own ORDER BY and LIMIT — that is the whole point
  // of the k-way merge — and Postgres will not accept those on a bare UNION arm. It
  // reads the ORDER BY as belonging to the union and fails at the next SELECT.
  it('parenthesises every union branch', () => {
    const sql = render(mergedCandidateSql(ctx()))
    expect(sql.match(/\) UNION ALL \(/g)?.length).toBe(6)
    expect(sql).not.toMatch(/LIMIT \$\d+\s+UNION ALL/)
  })

  it('orders the merged set on real columns of the subquery', () => {
    // Here `event_at`/`ref_id` ARE columns of `merged`, so naming them is correct —
    // the opposite of the rule inside a lane.
    expect(render(mergedCandidateSql(ctx())))
      .toContain('ORDER BY event_at DESC, ref_id COLLATE "C" DESC')
  })

  it('runs only the selected lane when a platform is chosen', () => {
    const sql = renderBound(mergedCandidateSql(ctx({ platform: 'bookwyrm' })))
    expect(sql).not.toContain('UNION ALL')
    expect(sql).toContain('/review/')
    expect(sql).not.toContain('scrobbles')
  })

  it('sorts and cuts the merged candidates the same way the lanes do', () => {
    const sql = render(mergedCandidateSql(ctx()))
    expect(sql).toContain('ORDER BY event_at DESC, ref_id COLLATE "C" DESC')
  })

  it('is null when nothing can match, rather than an empty union', () => {
    expect(mergedCandidateSql({
      ...ctx({ platform: 'mastodon' }),
      actorIds: Object.fromEntries(
        AP_PLATFORMS.map((p) => [p, [] as string[]]),
      ) as LaneContext['actorIds'],
    })).toBeNull()
  })

  it('binds actor ids as parameters, never inlined', () => {
    const { params } = dialect.sqlToQuery(mergedCandidateSql(ctx())!)
    expect(params).toContain('https://skvip.lol/users/markus')
  })
})

describe('tripsLane', () => {
  // Regression: the lane used to exclude `status = 'Planned'` as a stand-in for
  // "has not happened yet". viaduct.world only flips a trip to `Completed` on the
  // next CSV export, so the two legs Markus travelled on 6-7 August 2026 were still
  // `Planned` in the store — and the Tog stream stopped dead at 14 June while
  // /reise/torucon-2026, which gates on departure time only, listed them both.
  // A departed trip belongs on the page whatever the export says about it.
  it('gates on the departure time, not on the export status', () => {
    const sql = render(tripsLane(ctx()))
    expect(sql).not.toContain('status')
    expect(sql).toContain('<= now()')
  })
})
