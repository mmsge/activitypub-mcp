import {
  TIKTOK_ARCHIVE_FORMAT,
  postUrl,
  type TiktokArchive,
  type TiktokArchivePost,
} from './parse-tiktok-archive.js'

/**
 * Build a `tiktok-archive/1` file from the two sources on the Mac: TikTok's data export
 * (`user_data_tiktok.json`) and the yt-dlp metadata beside it (`meta/<id>.info.json`).
 *
 * Pure, so the matching is testable; the script that reads the folder and writes the file
 * is scripts/build-tiktok-archive.ts. See ADR 0078.
 *
 * **The join is the second a post went up.** The export has no video id, so the only thing
 * the two sources share is the time. The export's `Date` read as UTC equals yt-dlp's
 * `timestamp` to the second: checked on the real archive, 1 836 of 1 840 match with zero
 * offset. No tolerance window. A window would pair two posts made a minute apart with each
 * other's numbers, and nothing downstream could tell.
 *
 * **Only named fields are read.** The export also holds direct messages, searches, watch
 * history and the rest of a data-protection export. This reads `Post.Posts.VideoList` and,
 * from each entry, `Date`, `Likes`, `Sound`, `Location`, `WhoCanView` and how many
 * addresses `Link` holds. The addresses themselves are signed CDN links that expire in ten
 * days, and are never copied. From each info.json only the fields below are read.
 */

type AnyObject = Record<string, unknown>
const isObj = (v: unknown): v is AnyObject => !!v && typeof v === 'object' && !Array.isArray(v)

/** One post as the export has it, reduced to what the archive keeps. */
export interface ExportPost {
  /** Position in VideoList, from 0. */
  index: number
  /** Epoch seconds, from `Date` read as UTC. */
  at: number
  likes: number | null
  sound: string | null
  location: string | null
  whoCanView: string | null
  /** How many addresses `Link` held. More than one is a photo post. */
  linkCount: number
}

/** One yt-dlp info.json, reduced to what the archive keeps. */
export interface InfoMeta {
  id: string
  /** Epoch seconds. */
  at: number
  description: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  durationSeconds: number | null
  webpageUrl: string | null
  /** The account's username and display name, as yt-dlp saw them. */
  uploader: string | null
  channel: string | null
}

const EXPORT_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** `2022-01-13 06:54:26`, which TikTok writes in UTC, as epoch seconds. Null otherwise. */
export function exportDateSeconds(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(EXPORT_DATE)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[]
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)
  return Number.isNaN(ms) ? null : ms / 1000
}

function count(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/**
 * The posts in an export, or a thrown error naming where they were looked for. Entries
 * whose `Date` cannot be read are returned separately, so the caller reports them.
 */
export function readExportPosts(exportJson: unknown): { posts: ExportPost[]; badDates: Array<{ index: number; date: unknown }> } {
  const list = isObj(exportJson) && isObj(exportJson.Post) && isObj(exportJson.Post.Posts)
    ? exportJson.Post.Posts.VideoList
    : undefined
  if (!Array.isArray(list)) throw new Error('No posts found: the export has no Post.Posts.VideoList')

  const posts: ExportPost[] = []
  const badDates: Array<{ index: number; date: unknown }> = []
  list.forEach((entry, index) => {
    const e = isObj(entry) ? entry : {}
    const at = exportDateSeconds(e.Date)
    if (at == null) {
      badDates.push({ index, date: e.Date ?? null })
      return
    }
    posts.push({
      index,
      at,
      likes: count(e.Likes),
      sound: text(e.Sound),
      location: text(e.Location),
      whoCanView: text(e.WhoCanView),
      linkCount: typeof e.Link === 'string' ? e.Link.split(/\s+/).filter(Boolean).length : 0,
    })
  })
  return { posts, badDates }
}

/** The fields of one info.json the archive keeps, or null when it has no id or timestamp. */
export function readInfo(info: unknown): InfoMeta | null {
  if (!isObj(info)) return null
  const id = typeof info.id === 'string' && /^\d+$/.test(info.id) ? info.id : null
  const at = typeof info.timestamp === 'number' && Number.isFinite(info.timestamp) ? Math.trunc(info.timestamp) : null
  if (!id || at == null) return null
  const duration = typeof info.duration === 'number' && Number.isFinite(info.duration) && info.duration >= 0 ? info.duration : null
  return {
    id,
    at,
    description: text(info.description),
    views: count(info.view_count),
    likes: count(info.like_count),
    comments: count(info.comment_count),
    shares: count(info.repost_count),
    durationSeconds: duration,
    webpageUrl: text(info.webpage_url),
    uploader: text(info.uploader),
    channel: text(info.channel),
  }
}

export interface BuildReport {
  exportPosts: number
  infos: number
  matched: number
  /** Export posts with no metadata, by what they turned out to be. */
  withoutMetadata: { photo: number; video: number }
  /** Export entries whose Date could not be read: left out of the file. */
  badDates: Array<{ index: number; date: unknown }>
  /** Metadata whose second no export post has. Not in the file: the export is the scope. */
  unmatchedInfos: Array<{ id: string; postedAt: string }>
  /** Seconds where more than one post or more than one info.json sits: none of them is paired. */
  ambiguous: Array<{ postedAt: string; exportPosts: number; infos: string[] }>
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')

export function buildTiktokArchive(input: {
  exportPosts: ExportPost[]
  badDates?: Array<{ index: number; date: unknown }>
  infos: InfoMeta[]
  username: string
  displayName: string
  generatedAt: Date
}): { archive: TiktokArchive; report: BuildReport } {
  const username = input.username.toLowerCase()

  const infosAt = new Map<number, InfoMeta[]>()
  for (const i of input.infos) infosAt.set(i.at, [...(infosAt.get(i.at) ?? []), i])
  const postsAt = new Map<number, number>()
  for (const p of input.exportPosts) postsAt.set(p.at, (postsAt.get(p.at) ?? 0) + 1)

  const report: BuildReport = {
    exportPosts: input.exportPosts.length,
    infos: input.infos.length,
    matched: 0,
    withoutMetadata: { photo: 0, video: 0 },
    badDates: input.badDates ?? [],
    unmatchedInfos: [],
    ambiguous: [],
  }

  const used = new Set<string>()
  const reportedAmbiguous = new Set<number>()
  const posts: TiktokArchivePost[] = []
  for (const p of input.exportPosts) {
    const candidates = infosAt.get(p.at) ?? []
    const sharing = postsAt.get(p.at) ?? 0
    let info: InfoMeta | null = null
    if (candidates.length === 1 && sharing === 1) {
      info = candidates[0]!
    } else if (candidates.length > 0 && !reportedAmbiguous.has(p.at)) {
      reportedAmbiguous.add(p.at)
      report.ambiguous.push({ postedAt: iso(p.at), exportPosts: sharing, infos: candidates.map((c) => c.id) })
    }

    if (info) {
      used.add(info.id)
      report.matched++
      const kind = info.webpageUrl?.includes('/photo/') ? 'photo' : 'video'
      posts.push({
        postedAt: iso(p.at),
        kind,
        id: info.id,
        url: postUrl(username, kind, info.id),
        description: info.description,
        views: info.views,
        // yt-dlp's count, from the same moment as the views and comments beside it. The
        // export's own is the fallback.
        likes: info.likes ?? p.likes,
        comments: info.comments,
        shares: info.shares,
        durationSeconds: info.durationSeconds,
        sound: p.sound,
        location: p.location,
        whoCanView: p.whoCanView,
        onProfile: true,
      })
    } else {
      const kind = p.linkCount > 1 ? 'photo' : 'video'
      report.withoutMetadata[kind]++
      posts.push({
        postedAt: iso(p.at),
        kind,
        id: null,
        url: null,
        description: null,
        views: null,
        likes: p.likes,
        comments: null,
        shares: null,
        durationSeconds: null,
        sound: p.sound,
        location: p.location,
        whoCanView: p.whoCanView,
        onProfile: false,
      })
    }
  }

  // Metadata in an ambiguous second is already reported there.
  const inAmbiguous = new Set(report.ambiguous.flatMap((a) => a.infos))
  for (const i of [...input.infos].sort((a, b) => a.at - b.at)) {
    if (!used.has(i.id) && !inAmbiguous.has(i.id)) report.unmatchedInfos.push({ id: i.id, postedAt: iso(i.at) })
  }

  posts.sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  return {
    archive: {
      format: TIKTOK_ARCHIVE_FORMAT,
      account: { username, displayName: input.displayName },
      generatedAt: input.generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      posts,
    },
    report,
  }
}

/**
 * The account, from the newest info.json, unless the caller names it. Null when neither
 * says: the script then asks for `--username`.
 */
export function accountFromInfos(infos: InfoMeta[]): { username: string | null; displayName: string | null } {
  // Each from the newest file that has it: a sparse info.json must not blank the name.
  const newestFirst = [...infos].sort((a, b) => b.at - a.at)
  return {
    username: newestFirst.find((i) => i.uploader)?.uploader ?? null,
    displayName: newestFirst.find((i) => i.channel)?.channel ?? null,
  }
}
