/**
 * LinkedIn Member Data Portability API client.
 *
 * Docs: https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/
 *
 * The snapshot API returns up to 1000 items per request; it is not a live feed
 * but a point-in-time snapshot of the member's data. We re-fetch periodically
 * and upsert, relying on the sourceExternalId for deduplication.
 */

const API_BASE = 'https://api.linkedin.com'
const LINKEDIN_VERSION = '202501' // increment when API version changes

/** A single post as returned by the POSTS/MEMBER_SHARE_INFO snapshot domain. */
export interface LinkedInShareSnapshot {
  /** Share URN, e.g. "urn:li:share:…" */
  shareUrn?: string
  /** The text of the post */
  commentary?: string
  /** ISO-8601 creation timestamp */
  createdAt?: string
  /** Canonical URL on linkedin.com */
  postUrl?: string
  /** Media references */
  media?: LinkedInSnapshotMedia[]
  /** Article/link preview */
  article?: {
    source?: string
    title?: string
    description?: string
    thumbnail?: string
  }
  /** Lifecycle state — PUBLISHED | DRAFT | etc. */
  lifecycleState?: string
}

export interface LinkedInSnapshotMedia {
  /** Media URN or URL */
  id?: string
  url?: string
  /** Original filename or alt text */
  title?: string
  /** e.g. "IMAGE", "VIDEO", "DOCUMENT" */
  mediaType?: string
}

export interface SnapshotResponse {
  elements?: LinkedInShareSnapshot[]
  paging?: {
    count: number
    start: number
    total?: number
    links?: Array<{ href: string; rel: string }>
  }
}

/** Fetch all available post snapshots for the authenticated member. */
export async function fetchPostSnapshots(
  accessToken: string,
): Promise<LinkedInShareSnapshot[]> {
  const all: LinkedInShareSnapshot[] = []
  let start = 0
  const count = 100

  while (true) {
    const params = new URLSearchParams({
      q: 'criteria',
      domain: 'POSTS',
      start: String(start),
      count: String(count),
    })
    const url = `${API_BASE}/rest/memberSnapshotData?${params}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': LINKEDIN_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    })

    if (res.status === 404 || res.status === 403) {
      // DMA product not yet approved, or member has no posts
      break
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`LinkedIn snapshot API error (${res.status}): ${body}`)
    }

    const data = await res.json() as SnapshotResponse
    const elements = data.elements ?? []
    all.push(...elements)

    if (elements.length < count) break
    start += count
  }

  return all
}

/** Fetch profile info to upsert the actor row. */
export interface LinkedInMemberProfile {
  memberUrn: string
  displayName?: string
  vanityName?: string
  profilePicture?: string
}

export async function fetchMemberProfile(
  accessToken: string,
  memberUrn: string,
): Promise<LinkedInMemberProfile> {
  // Use OpenID userinfo which doesn't require special permissions
  const res = await fetch(`${API_BASE}/v2/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
    },
  })
  if (!res.ok) {
    return { memberUrn } // graceful fallback
  }
  const data = await res.json() as {
    sub?: string
    name?: string
    given_name?: string
    family_name?: string
    picture?: string
    locale?: { language: string; country: string }
  }
  return {
    memberUrn,
    displayName: data.name,
    profilePicture: data.picture,
  }
}
