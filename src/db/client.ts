import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config.js'
import * as schema from './schema.js'

let _sql: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (!_db) {
    _sql = postgres(config.DATABASE_URL)
    _db = drizzle(_sql, { schema })
  }
  return _db
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
