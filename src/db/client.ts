import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config.js'
import * as schema from './schema.js'
import { dryRunScope } from './dry-run.js'

export { inDryRun } from './dry-run.js'

let _sql: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

type Db = ReturnType<typeof drizzle<typeof schema>>

function baseDb(): Db {
  if (!_db) {
    _sql = postgres(config.DATABASE_URL)
    _db = drizzle(_sql, { schema })
  }
  return _db
}

/**
 * Inside a dry run every `getDb()` answers with its transaction instead of the pool, so
 * an importer that knows nothing about dry runs writes into a transaction that is then
 * rolled back (ADR 0073). Outside one the scope is empty and nothing changes.
 */
export function getDb(): Db {
  return (dryRunScope.getStore() as Db | undefined) ?? baseDb()
}

class DryRunRollback extends Error {}

/**
 * Run `fn` against a transaction that is always rolled back, and return what it returned.
 * Only for code whose effects are all in this database: a fetch, a webhook or a queue
 * started inside it happens for real. A nested `db.transaction` becomes a savepoint.
 */
export async function dryRun<T>(fn: () => Promise<T>): Promise<T> {
  let out: { value: T } | null = null
  try {
    await baseDb().transaction(async (tx) => {
      out = { value: await dryRunScope.run(tx, fn) }
      throw new DryRunRollback()
    })
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e
  }
  return (out as { value: T } | null)!.value
}

export function getSql() {
  if (!_sql) {
    _sql = postgres(config.DATABASE_URL)
    _db = drizzle(_sql, { schema })
  }
  return _sql
}

export async function closeDb() {
  if (_sql) {
    await _sql.end()
    _sql = null
    _db = null
  }
}
