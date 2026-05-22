import { getDb } from '../db/client.js'
import { actors } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from './logger.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export interface ActorRecord {
  apId: string
  source?: string
  handle: string | null
  username: string | null
  domain: string | null
  displayName: string | null
  summary: string | null
  iconUrl: string | null
  profileUrl?: string | null
  publicKeyPem: string | null
  inboxUrl: string | null
  sharedInboxUrl: string | null
}

async function fetchRemoteActor(url: string): Promise<ActorRecord> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching actor ${url}`)
  const data = await res.json() as Record<string, unknown>

  const domain = new URL(url).hostname
  const publicKey = data.publicKey as Record<string, unknown> | undefined
  const publicKeyPem = (publicKey?.publicKeyPem as string) ?? ''
  if (!publicKeyPem) throw new Error(`Actor ${url} has no publicKeyPem`)

  const inbox = data.inbox as string
  if (!inbox) throw new Error(`Actor ${url} has no inbox`)

  const endpoints = data.endpoints as Record<string, unknown> | undefined

  return {
    apId: data.id as string,
    handle: null,
    username: (data.preferredUsername as string) ?? null,
    domain,
    displayName: (data.name as string) ?? null,
    summary: (data.summary as string) ?? null,
    iconUrl: extractIconUrl(data),
    publicKeyPem,
    inboxUrl: inbox,
    sharedInboxUrl: (endpoints?.sharedInbox as string) ?? null,
  }
}

function extractIconUrl(data: Record<string, unknown>): string | null {
  const icon = data.icon as Record<string, unknown> | null
  if (!icon) return null
  if (typeof icon.url === 'string') return icon.url
  return null
}

export async function fetchActor(url: string): Promise<ActorRecord> {
  const db = getDb()
  const existing = await db.select().from(actors).where(eq(actors.apId, url)).limit(1)

  if (existing.length > 0) {
    const a = existing[0]
    const stale = Date.now() - a.fetchedAt.getTime() > CACHE_TTL_MS
    if (!stale) {
      return {
        apId: a.apId,
        source: a.source,
        handle: a.handle,
        username: a.username,
        domain: a.domain,
        displayName: a.displayName,
        summary: a.summary,
        iconUrl: a.iconUrl,
        profileUrl: a.profileUrl,
        publicKeyPem: a.publicKeyPem,
        inboxUrl: a.inboxUrl,
        sharedInboxUrl: a.sharedInboxUrl,
      }
    }
  }

  logger.debug({ url }, 'Fetching remote actor')
  const remote = await fetchRemoteActor(url)
  const raw = await fetch(url, {
    headers: { Accept: 'application/activity+json' },
  }).then(r => r.json())

  const handle = remote.username && remote.domain
    ? `@${remote.username}@${remote.domain}`
    : null

  await db.insert(actors).values({
    apId: remote.apId,
    handle,
    username: remote.username,
    domain: remote.domain,
    displayName: remote.displayName,
    summary: remote.summary,
    iconUrl: remote.iconUrl,
    publicKeyPem: remote.publicKeyPem,
    inboxUrl: remote.inboxUrl,
    sharedInboxUrl: remote.sharedInboxUrl,
    raw,
    fetchedAt: new Date(),
  }).onConflictDoUpdate({
    target: actors.apId,
    set: {
      handle,
      username: remote.username,
      displayName: remote.displayName,
      summary: remote.summary,
      iconUrl: remote.iconUrl,
      publicKeyPem: remote.publicKeyPem,
      inboxUrl: remote.inboxUrl,
      sharedInboxUrl: remote.sharedInboxUrl,
      raw,
      fetchedAt: new Date(),
      updatedAt: new Date(),
    },
  })

  return { ...remote, handle }
}

export async function resolveActorByHandle(handle: string): Promise<ActorRecord | null> {
  // LinkedIn URN (urn:li:person:…) — look up directly in DB
  if (handle.startsWith('urn:li:')) {
    const db = getDb()
    const rows = await db.select().from(actors).where(eq(actors.apId, handle)).limit(1)
    if (rows.length > 0) {
      const a = rows[0]
      return {
        apId: a.apId,
        source: a.source,
        handle: a.handle,
        username: a.username,
        domain: a.domain,
        displayName: a.displayName,
        summary: a.summary,
        iconUrl: a.iconUrl,
        profileUrl: a.profileUrl,
        publicKeyPem: a.publicKeyPem,
        inboxUrl: a.inboxUrl,
        sharedInboxUrl: a.sharedInboxUrl,
      }
    }
    return null
  }

  // LinkedIn vanity URL (linkedin.com/in/<name>) — look up by profileUrl or handle
  if (handle.includes('linkedin.com/in/')) {
    const db = getDb()
    const rows = await db.select().from(actors)
      .where(eq(actors.source, 'linkedin'))
      .limit(1)
    if (rows.length > 0) {
      const a = rows[0]
      return {
        apId: a.apId,
        source: a.source,
        handle: a.handle,
        username: a.username,
        domain: a.domain,
        displayName: a.displayName,
        summary: a.summary,
        iconUrl: a.iconUrl,
        profileUrl: a.profileUrl,
        publicKeyPem: a.publicKeyPem,
        inboxUrl: a.inboxUrl,
        sharedInboxUrl: a.sharedInboxUrl,
      }
    }
    return null
  }

  // handle is @user@domain
  const match = handle.match(/^@?([^@]+)@(.+)$/)
  if (!match) return null
  const [, username, domain] = match

  // WebFinger
  const resource = `acct:${username}@${domain}`
  const wfUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`
  try {
    const res = await fetch(wfUrl, { headers: { Accept: 'application/jrd+json' } })
    if (!res.ok) return null
    const jrd = await res.json() as { links?: Array<{ rel: string; href?: string; type?: string }> }
    const selfLink = jrd.links?.find(l => l.rel === 'self' && l.type?.includes('activity+json'))
    if (!selfLink?.href) return null
    return fetchActor(selfLink.href)
  } catch (e) {
    logger.warn({ handle, error: e }, 'WebFinger lookup failed')
    return null
  }
}
