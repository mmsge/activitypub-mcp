/**
 * Domains whose actors exist only as imported archives.
 *
 * `@MThorr@twitter.com` is stored like any other actor so every tool that takes an
 * `actor_handle` reads it the same way — but there is no ActivityPub server behind it
 * and never will be. Everything in this repo that would otherwise dial an actor's home
 * server (WebFinger, the actor refresh, the NodeInfo probe) has to know that, or it
 * spends its life failing against a host that answers in HTML. See ADR 0067.
 *
 * A closed list on purpose: the day a second archive is imported (Instagram, a blog) it
 * is a one-line addition here, and a domain that is *not* listed keeps the live-fetch
 * behaviour it has always had.
 */
export const ARCHIVE_DOMAINS: readonly string[] = ['twitter.com']

/** True for a bare domain (`twitter.com`) or any URL on one (`https://twitter.com/x`). */
export function isArchiveDomain(domainOrUrl: string): boolean {
  let host = domainOrUrl.trim().toLowerCase()
  if (host.includes('/')) {
    try {
      host = new URL(host).hostname
    } catch {
      return false
    }
  }
  return ARCHIVE_DOMAINS.includes(host)
}
