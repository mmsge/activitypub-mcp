// The seven categories the admin is grouped into (the mobile redesign, see ADR 0073).
// One list, so the Oversikt tiles, the Meir sheet and the desktop rail cannot drift.
//
// `href` is where a category opens today. The category pages (`/admin/k/:id`) land in a
// later phase; until then each points at the existing page that holds its main data,
// so the new navigation is usable from the first deploy.

export type CategoryId =
  | 'lesing'
  | 'sjaaing'
  | 'musikk'
  | 'reiser'
  | 'fediverse'
  | 'linkedin'
  | 'system'

export interface Category {
  id: CategoryId
  label: string
  href: string
}

export const CATEGORIES: Category[] = [
  { id: 'lesing', label: 'Lesing', href: '/admin/media?tab=books' },
  { id: 'sjaaing', label: 'Sjåing', href: '/admin/media?tab=watched' },
  { id: 'musikk', label: 'Musikk', href: '/admin/media?tab=scrobbles' },
  { id: 'reiser', label: 'Reiser', href: '/admin/stations' },
  { id: 'fediverse', label: 'Fediverse', href: '/admin/activities' },
  { id: 'linkedin', label: 'LinkedIn', href: '/admin/linkedin' },
  { id: 'system', label: 'System', href: '/admin/tools' },
]

export function categoryHref(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)!.href
}
