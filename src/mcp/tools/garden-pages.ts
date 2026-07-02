import { z } from 'zod'
import { and, inArray, isNull, or } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { gardenNotes } from '../../db/schema.js'
import { fetchGarden, stripFrontmatter, type GardenPage } from '../../lib/fetch-garden.js'

// Surface the markus.plus "Tankehav" (Obsidian Publish) pages as structured
// data: title, url, section, excerpt, image and an optional date. Consumers
// (e.g. the msge.no homepage) group by section and sort by date where present.
// With include_content the full markdown body (synced to garden_notes by the
// sync-garden-content job) is attached per page.
export const getGardenPagesSchema = z.object({
  section: z
    .string()
    .optional()
    .describe('Filter to one section (the first permalink segment, e.g. "reisar", "lesing", "melding", "prosjekt").'),
  limit: z.number().int().min(1).max(1000).default(500),
  sort_order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('Order dated pages by date; undated pages always sort after, alphabetically by title.'),
  include_content: z
    .boolean()
    .default(false)
    .describe(
      "Include each page's full markdown text as `content` (frontmatter stripped; null when not yet synced) plus `content_fetched_at`. Responses can be large — filter by section or lower the limit when collecting incrementally."
    ),
})

function sortPages(pages: GardenPage[], order: 'asc' | 'desc'): GardenPage[] {
  const dir = order === 'asc' ? 1 : -1
  return [...pages].sort((a, b) => {
    // Dated pages come first, ordered by date; undated fall to the end by title.
    if (a.date && b.date) return a.date < b.date ? -dir : a.date > b.date ? dir : 0
    if (a.date) return -1
    if (b.date) return 1
    return a.title.localeCompare(b.title, 'no')
  })
}

interface PageOut {
  title: string
  url: string
  path: string
  section: string
  description: string | null
  image: string | null
  date: string | null
  tags: string[]
  content?: string | null
  content_fetched_at?: string | null
}

// Explicit output shape so the internal sourcePath never leaks and the default
// (no-content) response stays identical to what existing consumers parse.
function toOutput(p: GardenPage): PageOut {
  return {
    title: p.title,
    url: p.url,
    path: p.path,
    section: p.section,
    description: p.description,
    image: p.image,
    date: p.date,
    tags: p.tags,
  }
}

export async function getGardenPages(input: z.infer<typeof getGardenPagesSchema>) {
  const all = await fetchGarden()
  const filtered = input.section
    ? all.filter((p) => p.section.toLowerCase() === input.section!.toLowerCase())
    : all

  // Section roll-up over the (unfiltered) set, so a consumer can build navigation
  // without a second call.
  const sectionCounts: Record<string, number> = {}
  for (const p of all) sectionCounts[p.section] = (sectionCounts[p.section] || 0) + 1
  const sections = Object.entries(sectionCounts)
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count)

  const selected = sortPages(filtered, input.sort_order).slice(0, input.limit)
  const pages = selected.map(toOutput)

  if (!input.include_content) {
    return { count: pages.length, total: all.length, sections, pages }
  }

  // Pages served from the RSS fallback (cache-doc outage) carry no sourcePath,
  // so also match rows by permalink path — the stored bodies must keep serving
  // exactly when the Obsidian origin is down.
  const sourcePaths = selected.map((p) => p.sourcePath).filter((s): s is string => s != null)
  type ContentRow = { sourcePath: string; path: string; content: string | null; fetchedAt: Date | null }
  const contentBySource = new Map<string, ContentRow>()
  const contentByPath = new Map<string, ContentRow>()
  if (selected.length > 0) {
    const db = getDb()
    const rows = await db
      .select({
        sourcePath: gardenNotes.sourcePath,
        path: gardenNotes.path,
        content: gardenNotes.content,
        fetchedAt: gardenNotes.fetchedAt,
      })
      .from(gardenNotes)
      .where(
        and(
          or(
            sourcePaths.length > 0 ? inArray(gardenNotes.sourcePath, sourcePaths) : undefined,
            inArray(gardenNotes.path, selected.map((p) => p.path))
          ),
          isNull(gardenNotes.deletedAt)
        )
      )
    for (const r of rows) {
      contentBySource.set(r.sourcePath, r)
      // On a permalink alias, prefer the row that has content.
      const existing = contentByPath.get(r.path)
      if (!existing || (existing.content == null && r.content != null)) contentByPath.set(r.path, r)
    }
  }

  let contentMissing = 0
  for (const [i, page] of pages.entries()) {
    const source = selected[i].sourcePath
    const row = (source ? contentBySource.get(source) : undefined) ?? contentByPath.get(page.path)
    page.content = row?.content != null ? stripFrontmatter(row.content) : null
    page.content_fetched_at = row?.fetchedAt?.toISOString() ?? null
    if (page.content == null) contentMissing++
  }
  return { count: pages.length, total: all.length, sections, content_missing: contentMissing, pages }
}
