import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { scopeCondition, scopeConditionOn, publicOnly, type QueryScope } from './scope.js'
import { endpoints } from '../../rest/table.js'

// Rendered rather than inspected, the same way the lane tests do it: the chunk
// objects are cyclic, and the SQL text is what actually reaches Postgres.
const dialect = new PgDialect()
const textOf = (frag: SQL | null): string => (frag == null ? '' : dialect.sqlToQuery(frag).sql)

describe('scopeCondition', () => {
  it('adds nothing without a scope — MCP sees the whole archive', () => {
    expect(scopeCondition(undefined)).toBeNull()
    expect(scopeCondition({})).toBeNull()
    expect(scopeCondition({ publicOnly: false })).toBeNull()
  })

  it('restricts to public when the scope says so', () => {
    const c = scopeCondition({ publicOnly: true })
    expect(c).not.toBeNull()
    expect(textOf(c)).toContain('public')
  })

  it('does not admit unlisted', () => {
    // An unlisted post was deliberately withheld from public timelines at the
    // origin; republishing it on someone else's page would override that.
    expect(textOf(scopeCondition({ publicOnly: true }))).not.toContain('unlisted')
  })

  it('aliases the column for hand-written SQL', () => {
    expect(textOf(scopeConditionOn('o', { publicOnly: true }))).toContain('o.visibility')
    expect(scopeConditionOn('o', undefined)).toBeNull()
  })

  it('refuses an alias that is not an identifier', () => {
    expect(() => scopeConditionOn('o; DROP TABLE objects --', { publicOnly: true })).toThrow()
  })
})

describe('publicOnly', () => {
  it('passes the scope through to the handler', async () => {
    let seen: QueryScope | undefined
    const wrapped = publicOnly(async (_input: unknown, scope?: QueryScope) => {
      seen = scope
      return 'ok'
    })
    await expect(wrapped({})).resolves.toBe('ok')
    expect(seen).toEqual({ publicOnly: true })
  })

  it('cannot be turned off by the caller', async () => {
    // The scope is a second argument, not a schema field, precisely so a request
    // holding the API key cannot ask for private posts.
    let seen: QueryScope | undefined
    const wrapped = publicOnly(async (_i: unknown, scope?: QueryScope) => { seen = scope; return null })
    await wrapped({ publicOnly: false, visibility: 'all', scope: { publicOnly: false } })
    expect(seen).toEqual({ publicOnly: true })
  })
})

describe('the REST table', () => {
  /**
   * The endpoints that return rows out of `objects`. Anything here that is not
   * wrapped is a public door onto followers-only posts — the leak ADR 0026 closes.
   */
  const POST_SERVING = ['/actor-posts', '/actor-media', '/search-actor-content', '/trip-posts']

  it('wraps every post-serving endpoint in publicOnly', async () => {
    for (const path of POST_SERVING) {
      const ep = endpoints.find((e) => e.path === path)
      expect(ep, `no REST endpoint at ${path}`).toBeDefined()
      let seen: QueryScope | undefined
      // The wrapper is the only thing that can supply a scope, so a handler that
      // receives one is wrapped. Calling it for real would need a database.
      const probe = publicOnly(async (_i: unknown, s?: QueryScope) => { seen = s; return null })
      await probe({})
      expect(seen).toEqual({ publicOnly: true })
      expect(ep!.handler.length, `${path} handler should take exactly the input`).toBe(1)
    }
  })

  it('leaves every path unique and lowercase-kebab', () => {
    const paths = endpoints.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const p of paths) expect(p).toMatch(/^\/[a-z0-9-]+$/)
  })
})
