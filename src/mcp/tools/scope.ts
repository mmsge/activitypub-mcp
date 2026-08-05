import type { SQL } from 'drizzle-orm'
import { publicOnlyCondition, publicOnlyOn } from '../../stream/visibility.js'

/**
 * Who is asking — the archive's owner, or the outside world.
 *
 * The same handler backs both the MCP tool and the REST endpoint (see
 * `src/rest/table.ts`), but the two have different audiences and must not return
 * the same rows:
 *
 *  - **MCP** is Markus reading his own archive. Followers-only posts are the
 *    point of keeping it; hiding them would make his own tooling lie to him.
 *  - **REST** is what feeds other sites. msge.no's `/togselfie` gallery is built
 *    from `/actor-posts?tag=togselfie` and republishes the result on a
 *    world-readable page, so a followers-only post reaching that endpoint is a
 *    leak waiting for the first non-public post to be tagged.
 *
 * The scope is a second argument rather than a schema field on purpose: a query
 * parameter would let any caller holding the API key ask for private posts, which
 * is precisely the door being closed. It cannot be set from outside the process.
 *
 * See ADR 0026.
 */
export interface QueryScope {
  /**
   * Restrict to posts the origin server marked public. Off for MCP, forced on for
   * every REST endpoint that serves post rows.
   *
   * `unlisted` does not count, matching the stream's default: an unlisted post was
   * deliberately withheld from public timelines at the origin, and republishing it
   * would override that choice. Neither does `unknown` — addressing we could not
   * read is not proof of anything, and ADR 0017 fails closed.
   */
  publicOnly?: boolean
}

/** The visibility predicate for a scope, or null when nothing should be added. */
export function scopeCondition(scope: QueryScope | undefined): SQL | null {
  return scope?.publicOnly ? publicOnlyCondition(false) : null
}

/** The same, against a table alias, for the hand-written SQL in trip-posts. */
export function scopeConditionOn(alias: string, scope: QueryScope | undefined): SQL | null {
  return scope?.publicOnly ? publicOnlyOn(alias, false) : null
}

/**
 * Bind a handler to the public-only scope, for the REST table.
 *
 * Written as a wrapper so the restriction lives at the one place that decides an
 * endpoint is publicly reachable, rather than being a rule each of the four
 * handlers has to remember — and so a fifth endpoint added later is a visible
 * choice between `publicOnly(...)` and a bare handler.
 */
export function publicOnly<I>(
  handler: (input: I, scope?: QueryScope) => Promise<unknown>,
): (input: I) => Promise<unknown> {
  return (input: I) => handler(input, { publicOnly: true })
}
