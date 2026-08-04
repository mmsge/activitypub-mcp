import { sql, type SQL } from 'drizzle-orm'

/**
 * Which BookWyrm edition a stored post is about, and how two references to the
 * same edition are made comparable.
 *
 * Both halves of this exist because the first version of the garden date
 * derivation recovered **zero** dates in production while passing every test.
 *
 * **Where the URL comes from.** `bookwyrm_objects.book_url` looks like the obvious
 * join key and is not: it is populated by the ingest path and is not reliable.
 * Every other consumer in this codebase — `hydrateBooks` in query.ts, the reading
 * lane — derives the edition from the AP object instead: `inReplyToBook` for
 * reviews and comments, the `Edition` tag for BookWyrm's generated start/finish
 * notes. This does the same, with `bookwyrm_objects.book_url` kept only as a last
 * fallback. Anything that needs the edition of a post should use this rather than
 * inventing a fourth way.
 *
 * **Why normalisation.** BookWyrm serves an edition under two shapes:
 *
 *     https://bookwyrm.social/book/1510472
 *     https://bookwyrm.social/book/1510472/s/septologien
 *
 * The federated posts carry the bare form; Markus' hand-written markus.plus
 * frontmatter carries whichever the browser was showing when he copied it — 96 of
 * his 241 book reviews have the slug. An equality join between the two matches
 * neither more nor less than by luck.
 */

/** Strip the `/s/<slug>` tail so both shapes of an edition URL compare equal. */
export function normalizeBookUrl(expr: SQL): SQL {
  return sql`regexp_replace(${expr}, '^(https?://[^/]+/book/[0-9]+).*$', '\\1')`
}

/** The TypeScript twin, for anything that normalises outside SQL. */
export function normalizeBookUrlText(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  const m = url.trim().match(/^(https?:\/\/[^/]+\/book\/[0-9]+)/)
  return m ? m[1] : url.trim()
}

function assertAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Unusable SQL alias: ${alias}`)
}

/**
 * The edition a stored `objects` row is about, normalised — or NULL.
 *
 * `objAlias` is the `objects` alias; `bwAlias` the joined `bookwyrm_objects` one,
 * used only as the final fallback.
 */
export function bookUrlOn(objAlias: string, bwAlias?: string): SQL {
  assertAlias(objAlias)
  const raw = sql.raw(`${objAlias}.raw`)
  const tags = sql.raw(`${objAlias}.tags`)

  // The Edition tag, guarded on the value actually being an array: `tag` is absent
  // on plenty of objects and jsonb_array_elements on a scalar raises.
  const editionTag = sql`(
    SELECT t->>'href'
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${tags}) = 'array' THEN ${tags} ELSE '[]'::jsonb END
    ) AS t
    WHERE t->>'type' = 'Edition' AND t->>'href' IS NOT NULL
    LIMIT 1)`

  // `undefined` means "no fallback"; anything else must be a real alias. An empty
  // string is falsy, so a truthiness check would silently drop the fallback and
  // answer NULL where a caller expected a URL.
  let fallback = sql``
  if (bwAlias !== undefined) {
    assertAlias(bwAlias)
    fallback = sql`, ${sql.raw(`${bwAlias}.book_url`)}`
  }

  return normalizeBookUrl(sql`coalesce(${raw}->>'inReplyToBook', ${editionTag}${fallback})`)
}
