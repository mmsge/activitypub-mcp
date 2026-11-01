import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The transaction an import preview is running in (ADR 0073), for the code running inside
 * it. Its own module, apart from `client.ts`, so code that only needs to ask "am I in a
 * preview?" (the webhook sender, the convergence watcher) never pulls in the database.
 */
export const dryRunScope = new AsyncLocalStorage<unknown>()

/** True while running inside `dryRun`: writes will be rolled back, so tell nobody. */
export function inDryRun(): boolean {
  return dryRunScope.getStore() !== undefined
}
