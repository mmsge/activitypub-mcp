import { z } from 'zod'
import { and, inArray, isNull } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { gardenNotes } from '../../db/schema.js'
import {
  fetchGarden,
  fetchGardenNoteRefs,
  noteAccessUrl,
  stripFrontmatter,
} from '../../lib/fetch-garden.js'
import { logger } from '../../lib/logger.js'

const LIVE_FETCH_TIMEOUT_MS = 10_000

export const getGardenPageSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Permalink path, e.g. "/reisar/interrail/2025" (leading slash optional; use "/" for the home page).'),
  url: z
    .string()
    .optional()
    .describe('Full markus.plus URL, e.g. "https://markus.plus/reisar/interrail/2025". Alternative to path.'),
})

function normalizePath(input: z.infer<typeof getGardenPageSchema>): string | { error: string } {
  let path = input.path
  if (input.url) {
    try {
      const u = new URL(input.url)
      if (u.hostname !== 'markus.plus' && u.hostname !== 'www.markus.plus') {
        return { error: `url must be a markus.plus URL, got host "${u.hostname}"` }
      }
      path = u.pathname
    } catch {
      return { error: `Invalid url: ${input.url}` }
    }
  }
  if (!path) return { error: 'Provide path or url' }
  try {
    path = decodeURIComponent(path)
  } catch {
    /* keep raw */
  }
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * One garden page with its full markdown text. Content is served from the
 * garden_notes cache (synced every 6 h); when a note hasn't been synced yet a
 * single live fetch is attempted and, on success, persisted — so text
 * accumulates even outside job cycles.
 */
export async function getGardenPage(input: z.infer<typeof getGardenPageSchema>) {
  const norm = normalizePath(input)
  if (typeof norm !== 'string') return norm

  // Permalinks are stored verbatim and some end with a slash (e.g. "/melding/bok/"),
  // so match the normalized path and its trailing-slash variant.
  const variants = norm === '/' ? [norm] : [norm, `${norm}/`]
  const page = (await fetchGarden()).find((p) => variants.includes(p.path))
  const db = getDb()
  const rows = await db
    .select()
    .from(gardenNotes)
    .where(and(inArray(gardenNotes.path, variants), isNull(gardenNotes.deletedAt)))
  // Two source files can share a permalink (a rename that left an alias); prefer
  // the row backing the page the list serves, else the most recently fetched.
  let row =
    rows.find((r) => page?.sourcePath && r.sourcePath === page.sourcePath) ??
    [...rows].sort((a, b) => (b.fetchedAt?.getTime() ?? 0) - (a.fetchedAt?.getTime() ?? 0))[0]

  // The page list omits the home note and RSS-fallback pages carry no sourcePath,
  // so on a fresh DB the note refs (which include both) are the resolver of last
  // resort for the live fetch below. Served from the same cached cache doc.
  const ref =
    !page?.sourcePath && !row
      ? (await fetchGardenNoteRefs()).find((r) => variants.includes(r.path))
      : undefined

  if (!page && !row && !ref) return { error: `No garden page found for path "${norm}"` }

  if (row?.content == null) {
    const sourcePath = row?.sourcePath ?? page?.sourcePath ?? ref?.sourcePath
    if (sourcePath) {
      try {
        const res = await fetch(noteAccessUrl(sourcePath), {
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
        })
        if (res.ok) {
          const body = await res.text()
          const [updated] = await db
            .insert(gardenNotes)
            .values({
              sourcePath,
              path: page?.path ?? ref?.path ?? norm,
              title: page?.title ?? ref?.title ?? norm,
              content: body,
              etag: res.headers.get('etag'),
              lastModified: res.headers.get('last-modified'),
              fetchedAt: new Date(),
              lastCheckedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: gardenNotes.sourcePath,
              set: {
                content: body,
                etag: res.headers.get('etag'),
                lastModified: res.headers.get('last-modified'),
                fetchedAt: new Date(),
                lastCheckedAt: new Date(),
                fetchError: null,
                failCount: 0,
                deletedAt: null,
                updatedAt: new Date(),
              },
            })
            .returning()
          row = updated
        }
      } catch (e) {
        logger.warn({ sourcePath, error: e }, 'Live garden note fetch failed')
      }
    }
  }

  const canonicalPath = page?.path ?? row?.path ?? ref?.path ?? norm
  return {
    title: page?.title ?? row?.title ?? ref?.title ?? norm,
    url: page?.url ?? `https://markus.plus${canonicalPath === '/' ? '' : canonicalPath}`,
    // The home note (path "/") is not part of the section'd page list, so it has
    // no section; same for pages the cache doc no longer lists.
    path: canonicalPath,
    section: page?.section ?? null,
    description: page?.description ?? null,
    image: page?.image ?? null,
    date: page?.date ?? null,
    tags: page?.tags ?? [],
    content: row?.content != null ? stripFrontmatter(row.content) : null,
    content_fetched_at: row?.fetchedAt?.toISOString() ?? null,
    content_error: row?.content == null ? (row?.fetchError ?? 'Content not yet synced') : null,
  }
}
