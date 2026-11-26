/**
 * Domains whose actors exist only as imported archives.
 *
 * `@MThorr@twitter.com` and `@markusrote@tiktok.com` are stored like any other actor so
 * every tool that takes an `actor_handle` reads them the same way — but there is no
 * ActivityPub server behind them and never will be. Everything in this repo that would
 * otherwise dial an actor's home server (WebFinger, the actor refresh, the NodeInfo probe,
 * a live engagement read) has to know that, or it spends its life failing against a host
 * that answers in HTML. See ADR 0067 and 0078.
 *
 * A closed list on purpose: a new archive is a one-line addition here, and a domain that
 * is *not* listed keeps the live-fetch behaviour it has always had. TikTok needs both its
 * hosts: the handle is on `tiktok.com` and every page, the actor's `ap_id` included, is on
 * `www.tiktok.com`.
 */
export const ARCHIVE_DOMAINS: readonly string[] = ['twitter.com', 'tiktok.com', 'www.tiktok.com']

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
