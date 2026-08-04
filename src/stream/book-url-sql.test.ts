import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import { bookUrlOn, normalizeBookUrl, normalizeBookUrlText } from './book-url-sql.js'

const dialect = new PgDialect()
const render = (s: SQL): string => dialect.sqlToQuery(s).sql

describe('normalizeBookUrlText', () => {
  it('strips the /s/<slug> tail BookWyrm adds in the browser', () => {
    // 96 of Markus' 241 book reviews carry the slug because that is what the URL
    // bar showed when he copied it. The federated posts carry the bare form. An
    // equality join between the two matched by luck.
    expect(normalizeBookUrlText('https://bookwyrm.social/book/1510472/s/septologien'))
      .toBe('https://bookwyrm.social/book/1510472')
  })

  it('leaves an already-bare edition URL alone', () => {
    expect(normalizeBookUrlText('https://bookwyrm.social/book/1674348'))
      .toBe('https://bookwyrm.social/book/1674348')
  })

  it('is idempotent, so normalising twice is safe', () => {
    const once = normalizeBookUrlText('https://bookwyrm.social/book/1510472/s/x')!
    expect(normalizeBookUrlText(once)).toBe(once)
  })

  it('handles a trailing slash and query junk', () => {
    expect(normalizeBookUrlText('https://bookwyrm.social/book/1510472/'))
      .toBe('https://bookwyrm.social/book/1510472')
    expect(normalizeBookUrlText('https://bookwyrm.social/book/1510472?utm=x'))
      .toBe('https://bookwyrm.social/book/1510472')
  })

  it('passes through anything that is not an edition URL rather than mangling it', () => {
    expect(normalizeBookUrlText('https://bookwyrm.social/user/mvrkws'))
      .toBe('https://bookwyrm.social/user/mvrkws')
  })

  it('returns null for nothing usable', () => {
    for (const bad of [null, undefined, '', '   ']) {
      expect(normalizeBookUrlText(bad)).toBeNull()
    }
  })

  it('agrees with the SQL regex on the shapes that matter', () => {
    // The two must not drift: the SQL normalises one side of the join and this
    // normalises the other wherever the join happens outside SQL.
    expect(render(normalizeBookUrl(sql`x`))).toContain('/book/[0-9]+')
  })
})

describe('bookUrlOn', () => {
  it('prefers inReplyToBook, then the Edition tag, then bookwyrm_objects', () => {
    // Order is the point. bookwyrm_objects.book_url looks like the obvious join key
    // and is unreliable — trusting it first recovered zero dates in production.
    const text = render(bookUrlOn('o', 'bo'))
    const i = text.indexOf('inReplyToBook')
    const t = text.indexOf("'Edition'")
    const b = text.indexOf('bo.book_url')
    expect(i).toBeGreaterThan(-1)
    expect(t).toBeGreaterThan(i)
    expect(b).toBeGreaterThan(t)
  })

  it('normalises whatever it finds', () => {
    expect(render(bookUrlOn('o', 'bo'))).toContain('regexp_replace')
  })

  it('guards jsonb_array_elements against a non-array tag', () => {
    // `tag` is absent on plenty of objects, and jsonb_array_elements on a scalar
    // raises — which would take down the whole derivation, not one row.
    expect(render(bookUrlOn('o'))).toContain("jsonb_typeof(o.tags) = 'array'")
  })

  it('works without a bookwyrm_objects alias', () => {
    const text = render(bookUrlOn('o'))
    expect(text).toContain('inReplyToBook')
    expect(text).not.toContain('book_url')
  })

  it('refuses an alias that is not an identifier', () => {
    for (const bad of ['o; drop table objects', 'O', '1o', '', 'o p']) {
      expect(() => bookUrlOn(bad)).toThrow(/Unusable SQL alias/)
      expect(() => bookUrlOn('o', bad)).toThrow(/Unusable SQL alias/)
    }
  })
})
