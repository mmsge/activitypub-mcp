import { z } from 'zod'
import { fetchGarden, type GardenPage } from '../../lib/fetch-garden.js'

// Surface the markus.plus "Tankehav" (Obsidian Publish) pages as structured
// data: title, url, section, excerpt, image and an optional date. Consumers
// (e.g. the msge.no homepage) group by section and sort by date where present.
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

  const pages = sortPages(filtered, input.sort_order).slice(0, input.limit)
  return { count: pages.length, total: all.length, sections, pages }
}
