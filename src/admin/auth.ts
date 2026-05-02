import { compare } from 'bcryptjs'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { adminSessions } from '../db/schema.js'
import { eq, lt } from 'drizzle-orm'
import { randomBytes, createHash } from 'crypto'

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000 // 24h

export async function verifyAdminPassword(password: string): Promise<boolean> {
  return compare(password, config.ADMIN_PASSWORD_HASH)
}

export async function createSession(): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const db = getDb()
  await db.insert(adminSessions).values({
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  })
  return token
}

export async function validateSession(token: string): Promise<boolean> {
  if (!token) return false
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const db = getDb()
  const [session] = await db.select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, tokenHash))
    .limit(1)
  if (!session) return false
  if (session.expiresAt < new Date()) {
    await db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash))
    return false
  }
  return true
}

export async function deleteSession(token: string): Promise<void> {
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const db = getDb()
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash))
}

export async function pruneExpiredSessions(): Promise<void> {
  const db = getDb()
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()))
}
