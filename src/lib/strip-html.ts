// Named entities seen in fediverse post HTML. Case-sensitive, as HTML entities
// are; the Norwegian letters matter most here (Mastodon and friends emit them
// for nb/nn content), the rest are common typography.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aring: 'å',
  Aring: 'Å',
  oslash: 'ø',
  Oslash: 'Ø',
  aelig: 'æ',
  AElig: 'Æ',
  auml: 'ä',
  Auml: 'Ä',
  ouml: 'ö',
  Ouml: 'Ö',
  uuml: 'ü',
  Uuml: 'Ü',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  Egrave: 'È',
  szlig: 'ß',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
}

// Decode entities in a single pass so already-escaped text is never
// double-decoded (`&amp;lt;` must become `&lt;`, not `<`). Numeric entities
// (`&#248;`, `&#x2019;`) decode via the code point; unknown or invalid
// entities are left as-is.
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return match
      try {
        return String.fromCodePoint(cp)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
