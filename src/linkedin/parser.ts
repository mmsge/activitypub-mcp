/**
 * Maps LinkedIn post snapshots to the objects table schema.
 * Downloads media and rewrites attachment URLs to point at the local /media/ host.
 */
import { config } from '../config.js'
import { downloadAndSaveMedia } from '../media/storage.js'
import { logger } from '../lib/logger.js'
import type { LinkedInShareSnapshot } from './client.js'

export interface ParsedLinkedInPost {
  /** Synthetic AP-style ID used as objects.apId */
  apId: string
  /** LinkedIn share URN (urn:li:share:…) stored as sourceExternalId */
  sourceExternalId: string
  type: 'LinkedInPost'
  actorApId: string // member URN
  content: string
  contentText: string
  url: string | null
  publishedAt: Date | null
  attachments: ParsedAttachment[]
  raw: LinkedInShareSnapshot
}

export interface ParsedAttachment {
  type: 'Image' | 'Video' | 'Document' | 'Link'
  mediaType: string
  /** Public URL on this server (/media/<id>) or external URL for links */
  url: string
  sourceUrl?: string
  title?: string
  width?: number
  height?: number
}

export async function parseLinkedInPost(
  snapshot: LinkedInShareSnapshot,
  memberUrn: string,
  appDomain: string,
): Promise<ParsedLinkedInPost | null> {
  // Only process published posts
  if (snapshot.lifecycleState && snapshot.lifecycleState !== 'PUBLISHED') return null

  const shareUrn = snapshot.shareUrn
  if (!shareUrn) return null

  const content = snapshot.commentary ?? ''
  const publishedAt = snapshot.createdAt ? new Date(snapshot.createdAt) : null
  const url = snapshot.postUrl ?? null

  // Build a stable synthetic apId from the share URN
  const apId = `https://${appDomain}/linkedin/posts/${encodeURIComponent(shareUrn)}`

  const attachments: ParsedAttachment[] = []

  // Process media attachments
  if (snapshot.media?.length) {
    for (const m of snapshot.media) {
      const mediaUrl = m.url
      if (!mediaUrl) continue

      const mediaType = guessMediaType(m.mediaType, mediaUrl)
      const attType = mediaTypeToAttType(m.mediaType ?? '')

      if (attType === 'Link') {
        attachments.push({ type: 'Link', mediaType: 'text/html', url: mediaUrl, title: m.title })
        continue
      }

      // Download and host locally
      const saved = await downloadAndSaveMedia(mediaUrl, mediaType)
      if (saved) {
        attachments.push({
          type: attType,
          mediaType: saved.mimeType,
          url: `https://${appDomain}${saved.publicUrl}`,
          sourceUrl: mediaUrl,
          title: m.title,
        })
      } else {
        // Fallback: keep external URL
        attachments.push({
          type: attType,
          mediaType,
          url: mediaUrl,
          sourceUrl: mediaUrl,
          title: m.title,
        })
      }
    }
  }

  // Article/link preview
  if (snapshot.article) {
    const art = snapshot.article
    attachments.push({
      type: 'Link',
      mediaType: 'text/html',
      url: art.source ?? '',
      title: art.title,
    })
    if (art.thumbnail) {
      const saved = await downloadAndSaveMedia(art.thumbnail, 'image/jpeg')
      if (saved) {
        attachments.push({
          type: 'Image',
          mediaType: saved.mimeType,
          url: `https://${appDomain}${saved.publicUrl}`,
          sourceUrl: art.thumbnail,
          title: art.title,
        })
      }
    }
  }

  return {
    apId,
    sourceExternalId: shareUrn,
    type: 'LinkedInPost',
    actorApId: memberUrn,
    content,
    contentText: content, // LinkedIn commentary is plain text
    url,
    publishedAt,
    attachments,
    raw: snapshot,
  }
}

function guessMediaType(linkedInType: string | undefined, url: string): string {
  const t = (linkedInType ?? '').toUpperCase()
  if (t === 'IMAGE') return guessImageType(url)
  if (t === 'VIDEO') return 'video/mp4'
  if (t === 'DOCUMENT') return 'application/pdf'
  // Fallback from URL extension
  if (/\.jpe?g/i.test(url)) return 'image/jpeg'
  if (/\.png/i.test(url)) return 'image/png'
  if (/\.gif/i.test(url)) return 'image/gif'
  if (/\.webp/i.test(url)) return 'image/webp'
  if (/\.mp4/i.test(url)) return 'video/mp4'
  if (/\.pdf/i.test(url)) return 'application/pdf'
  return 'application/octet-stream'
}

function guessImageType(url: string): string {
  if (/\.png/i.test(url)) return 'image/png'
  if (/\.gif/i.test(url)) return 'image/gif'
  if (/\.webp/i.test(url)) return 'image/webp'
  return 'image/jpeg'
}

function mediaTypeToAttType(linkedInType: string): ParsedAttachment['type'] {
  const t = linkedInType.toUpperCase()
  if (t === 'IMAGE') return 'Image'
  if (t === 'VIDEO') return 'Video'
  if (t === 'DOCUMENT') return 'Document'
  return 'Link'
}
