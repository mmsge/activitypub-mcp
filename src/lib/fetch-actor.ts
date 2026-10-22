import { getDb } from '../db/client.js'
import { actors } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { logger } from './logger.js'
import { fetchSoftwareName } from './fetch-nodeinfo.js'
import { isArchiveDomain } from './archive-actors.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export interface ActorRecord {
  apId: string
  handle: string | null
  username: string | null
  domain: string
  displayName: string | null
  summary: string | null
  iconUrl: string | null
  publicKeyPem: string
  inboxUrl: string
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

function toActorRecord(a: typeof actors.$inferSelect): ActorRecord {
  return {
    apId: a.apId,
    handle: a.handle,
    username: a.username,
    domain: a.domain,
    displayName: a.displayName,
    summary: a.summary,
    iconUrl: a.iconUrl,
    publicKeyPem: a.publicKeyPem,
    inboxUrl: a.inboxUrl,
    sharedInboxUrl: a.sharedInboxUrl,
  }
}

export async function fetchActor(url: string): Promise<ActorRecord> {
  const db = getDb()
  const existing = await db.select().from(actors).where(eq(actors.apId, url)).limit(1)

  // An archive actor has no server to ask. Whatever the import stored is the answer at any
  // age — the 24h cache below would otherwise send it off to twitter.com to be "refreshed".
  if (isArchiveDomain(url)) {
    if (existing.length > 0) return toActorRecord(existing[0])
    throw new Error(`${url} is an archive actor and has not been imported`)
  }

  if (existing.length > 0) {
    const a = existing[0]
    const stale = Date.now() - a.fetchedAt.getTime() > CACHE_TTL_MS
    if (!stale) return toActorRecord(a)
  }

  logger.debug({ url }, 'Fetching remote actor')
  const remote = await fetchRemoteActor(url)
  const raw = await fetch(url, {
    headers: { Accept: 'application/activity+json' },
  }).then(r => r.json())

  // Best-effort NodeInfo probe so the actor carries its origin software. A null result
  // (host down / no endpoint) must not clobber a previously-detected value on refresh.
  const software = await fetchSoftwareName(remote.domain)

  const handle = remote.username && remote.domain
    ? `@${remote.username}@${remote.domain}`
    : null

  await db.insert(actors).values({
    apId: remote.apId,
    handle,
    username: remote.username,
    domain: remote.domain,
    software,
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
      software: sql`coalesce(${software}, ${actors.software})`,
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
  // handle is @user@domain
  const match = handle.match(/^@?([^@]+)@(.+)$/)
  if (!match) return null
  const [, username, domain] = match

  // Archive actors live only in our own table; there is nothing to WebFinger. Twitter
  // handles are case-insensitive, so the lookup is too — `@mthorr@twitter.com` finds
  // the account stored as `@MThorr@twitter.com`.
  if (isArchiveDomain(domain)) {
    const rows = await getDb().select().from(actors)
      .where(sql`lower(${actors.handle}) = ${`@${username}@${domain}`.toLowerCase()}`)
      .limit(1)
    return rows.length > 0 ? toActorRecord(rows[0]) : null
  }

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
