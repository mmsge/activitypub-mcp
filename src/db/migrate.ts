import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function runMigrations() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1 })
  const db = drizzle(sql)
  console.log('Running migrations...')
  await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') })
  console.log('Migrations complete')
  await sql.end()
}

runMigrations().catch(err => {
  console.error(err)
  process.exit(1)
})
