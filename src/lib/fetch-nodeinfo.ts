import { logger } from './logger.js'

/**
 * Identify the fediverse software behind a domain via NodeInfo — the canonical,
 * software-agnostic discovery endpoint every major implementation serves. Chain:
 * `/.well-known/nodeinfo` → pick the highest schema link → fetch it → `software.name`.
 *
 * Best-effort by design: any failure (unreachable host, missing endpoint, malformed
 * document, timeout) resolves to null rather than throwing, so a probe never breaks
 * actor ingestion. The returned name is lowercased ('mastodon', 'pixelfed', 'bookwyrm',
 * 'loops', …).
 */

// Generous: this is a best-effort background probe, and a cold origin cache can be
// slow. Too tight a timeout drops a reachable server to null (observed on a cold
// BookWyrm NodeInfo). Matches the engagement HTTP timeout.
const NODEINFO_TIMEOUT_MS = 10_000

async function fetchJson(url: string, timeoutMs: number): Promise<any | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSoftwareName(
  domain: string,
  timeoutMs = NODEINFO_TIMEOUT_MS,
): Promise<string | null> {
  const disco = await fetchJson(`https://${domain}/.well-known/nodeinfo`, timeoutMs)
  const links = (disco?.links ?? []) as Array<{ rel?: string; href?: string }>
  // Prefer the newest schema we understand, but any nodeinfo schema link carries
  // software.name, so fall back to whichever is advertised.
  const link =
    links.find((l) => l.rel?.includes('nodeinfo.diaspora.software/ns/schema/2.1')) ??
    links.find((l) => l.rel?.includes('nodeinfo.diaspora.software/ns/schema/2.0')) ??
    links.find((l) => l.rel?.includes('nodeinfo'))
  if (!link?.href) {
    logger.debug({ domain }, 'No NodeInfo link advertised')
    return null
  }
  const doc = await fetchJson(link.href, timeoutMs)
  const name = doc?.software?.name
  return typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : null
}

// Prettified display names for the common software; anything unmapped is Title-cased.
const SERVICE_LABELS: Record<string, string> = {
  mastodon: 'Mastodon',
  pixelfed: 'Pixelfed',
  bookwyrm: 'BookWyrm',
  loops: 'Loops',
  pleroma: 'Pleroma',
  akkoma: 'Akkoma',
  misskey: 'Misskey',
  gotosocial: 'GoToSocial',
  peertube: 'PeerTube',
  lemmy: 'Lemmy',
  writefreely: 'WriteFreely',
  friendica: 'Friendica',
}

/** Human-facing service label for a NodeInfo software name. Null in → null out. */
export function serviceLabel(software: string | null | undefined): string | null {
  if (!software) return null
  return SERVICE_LABELS[software] ?? software.charAt(0).toUpperCase() + software.slice(1)
}
