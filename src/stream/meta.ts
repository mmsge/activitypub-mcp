import { config } from '../config.js'
import { escapeHtml } from '../lib/html.js'
import { streamOrigin } from './host.js'
import { parseSources } from './sources.js'
import type { Entry } from './entries.js'

/**
 * Head metadata: link previews, structured data, and the archive's own dates.
 *
 * Entries link out to their origin and have no page here, so the only things worth
 * previewing are the stream and its filtered views — which is exactly what these
 * describe.
 */

export interface MetaInput {
  title: string
  description: string
  canonical: string
  entries: Entry[]
}

/**
 * JSON-LD must never be able to close its own script element. `</script` inside a
 * JSON string is legal JSON and illegal HTML, and a post title containing it would
 * otherwise end the block and drop the rest of the page into the document.
 */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Profiles to declare as the same person, so the accounts are linked to each other. */
function sameAs(): string[] {
  const out = [`https://${config.APP_DOMAIN}/@${config.APP_USERNAME}`]
  try {
    for (const s of parseSources(config.STREAM_SOURCES)) {
      const [, user, domain] = /^@([^@]+)@(.+)$/.exec(s.handle) ?? []
      if (user && domain) out.push(`https://${domain}/@${user}`)
    }
  } catch {
    // A malformed setting must not take the page down; the links are decoration.
  }
  return out
}

export function renderHead(input: MetaInput): string {
  const origin = streamOrigin()
  const image = `${origin}/kort.png`
  const newest = input.entries[0]?.eventAt ?? null

  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Meg">`,
    `<meta property="og:locale" content="nn_NO">`,
    `<meta property="og:title" content="${escapeHtml(input.title)}">`,
    `<meta property="og:description" content="${escapeHtml(input.description)}">`,
    `<meta property="og:url" content="${escapeHtml(input.canonical)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(input.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(input.description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  ]

  // The archive's own freshness, from the newest thing in it. Deliberately not an
  // HTTP Last-Modified: this page is live data, and the box convention (naustet
  // ADR 0015) reserves that header for genuinely static pages.
  if (newest) {
    tags.push(`<meta property="article:modified_time" content="${newest.toISOString()}">`)
  }

  const person = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: 'Meg',
    url: input.canonical,
    inLanguage: 'nn-NO',
    ...(newest ? { dateModified: newest.toISOString() } : {}),
    mainEntity: {
      '@type': 'Person',
      name: 'Markus',
      url: origin,
      image: `${origin}/ikon.png`,
      sameAs: sameAs(),
    },
  }
  tags.push(`<script type="application/ld+json">${jsonLd(person)}</script>`)

  // The entries themselves, pointing at their origins rather than at us.
  if (input.entries.length > 0) {
    const list = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: input.entries.slice(0, 20).map((e, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        ...(e.originUrl ? { url: e.originUrl } : {}),
      })),
    }
    tags.push(`<script type="application/ld+json">${jsonLd(list)}</script>`)
  }

  return tags.join('\n')
}

/** robots.txt for the stream host. */
export function renderRobots(): string {
  return [
    'User-agent: *',
    'Allow: /',
    // The cursor space is unbounded; a crawler walking it would page through the
    // whole archive one request at a time and cache-bust every step.
    'Disallow: /*?etter=',
    '',
    `Sitemap: ${streamOrigin()}/sitemap.xml`,
    '',
  ].join('\n')
}

export interface SitemapEntry {
  loc: string
  lastmod?: string
}

export function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => [
      '  <url>',
      `    <loc>${escapeHtml(e.loc)}</loc>`,
      e.lastmod ? `    <lastmod>${escapeHtml(e.lastmod)}</lastmod>` : null,
      '  </url>',
    ].filter(Boolean).join('\n'))
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}
