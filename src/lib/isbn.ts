// Pure ISBN + language helpers used by the book-metadata enrichment pipeline.
// No I/O here so the resolution/normalization logic stays unit-testable.

export type IsbnSource = 'bookwyrm' | 'review' | 'bookwyrm_object'

export interface ResolvedIsbn {
  isbn13: string | null
  isbn10: string | null
  source: IsbnSource | null
}

// Strip hyphens/spaces and upper-case a trailing X. Returns null for anything
// that isn't a plausible 10- or 13-digit ISBN body.
export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{13}$/.test(s)) return s
  if (/^\d{9}[\dX]$/.test(s)) return s
  return null
}

export function isValidIsbn10(raw: string): boolean {
  const s = normalizeIsbn(raw)
  if (!s || s.length !== 10) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const c = s[i]
    const v = c === 'X' ? 10 : Number(c)
    if (Number.isNaN(v)) return false
    sum += v * (10 - i)
  }
  return sum % 11 === 0
}

export function isValidIsbn13(raw: string): boolean {
  const s = normalizeIsbn(raw)
  if (!s || s.length !== 13) return false
  let sum = 0
  for (let i = 0; i < 13; i++) {
    const v = Number(s[i])
    if (Number.isNaN(v)) return false
    sum += i % 2 === 0 ? v : v * 3
  }
  return sum % 10 === 0
}

// 978-prefix an ISBN-10 and recompute the check digit. Returns null on invalid input.
export function isbn10to13(raw: string): string | null {
  const s = normalizeIsbn(raw)
  if (!s || s.length !== 10 || !isValidIsbn10(s)) return null
  const body = '978' + s.slice(0, 9)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  const check = (10 - (sum % 10)) % 10
  return body + String(check)
}

// Only 978-prefixed ISBN-13s have an ISBN-10 equivalent; 979 books do not.
export function isbn13to10(raw: string): string | null {
  const s = normalizeIsbn(raw)
  if (!s || s.length !== 13 || !isValidIsbn13(s) || !s.startsWith('978')) return null
  const body = s.slice(3, 12)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i)
  const remainder = (11 - (sum % 11)) % 11
  const check = remainder === 10 ? 'X' : String(remainder)
  return body + check
}

/**
 * Pick the best ISBN from prioritized candidates. Each candidate is validated,
 * normalized, and (when possible) expanded to both isbn13 and isbn10. The first
 * candidate that yields a valid ISBN wins, and its source is recorded — so the
 * caller's array order encodes the precedence (Edition → review → bookwyrm_object).
 */
export function resolveBestIsbn(
  candidates: { value: string | null | undefined; source: IsbnSource }[],
): ResolvedIsbn {
  for (const { value, source } of candidates) {
    const s = normalizeIsbn(value)
    if (!s) continue
    if (s.length === 13 && isValidIsbn13(s)) {
      return { isbn13: s, isbn10: isbn13to10(s), source }
    }
    if (s.length === 10 && isValidIsbn10(s)) {
      return { isbn13: isbn10to13(s), isbn10: s, source }
    }
  }
  return { isbn13: null, isbn10: null, source: null }
}

// --- Language normalization -------------------------------------------------
// Sources disagree on language representation: BookWyrm uses "English"/"eng",
// markus.plus uses arrays like ["danish","dansk"], Google Books uses "en", and
// OpenLibrary uses { key: "/languages/eng" }. Map them all to ISO-639-1 codes so
// the merged `language` is comparable. Unknown values fall through to a trimmed
// lower-cased token rather than being dropped.
const LANGUAGE_MAP: Record<string, string> = {
  // English
  en: 'en', eng: 'en', english: 'en', engelsk: 'en',
  // Norwegian — bokmål and nynorsk both collapse to `no` so the dominant language
  // isn't fragmented across written forms (BookWyrm tags them inconsistently).
  no: 'no', nor: 'no', norwegian: 'no', norsk: 'no',
  nb: 'no', nob: 'no', bokmål: 'no', bokmal: 'no',
  nn: 'no', nno: 'no', nynorsk: 'no',
  // Danish
  da: 'da', dan: 'da', danish: 'da', dansk: 'da',
  // Swedish
  sv: 'sv', swe: 'sv', swedish: 'sv', svenska: 'sv', svensk: 'sv',
  // German
  de: 'de', ger: 'de', deu: 'de', german: 'de', tysk: 'de', deutsch: 'de',
  // French
  fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr', fransk: 'fr', français: 'fr',
  // Spanish
  es: 'es', spa: 'es', spanish: 'es', spansk: 'es', español: 'es',
  // Italian
  it: 'it', ita: 'it', italian: 'it', italiensk: 'it',
  // Dutch
  nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl', nederlandsk: 'nl',
  // Finnish
  fi: 'fi', fin: 'fi', finnish: 'fi', finsk: 'fi',
  // Icelandic
  is: 'is', isl: 'is', ice: 'is', icelandic: 'is', islandsk: 'is',
  // Other languages that turn up in the reading data
  ko: 'ko', kor: 'ko', korean: 'ko', koreansk: 'ko',
  ja: 'ja', jpn: 'ja', japanese: 'ja', japansk: 'ja',
  zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh', kinesisk: 'zh',
  ru: 'ru', rus: 'ru', russian: 'ru', russisk: 'ru',
  pl: 'pl', pol: 'pl', polish: 'pl', polsk: 'pl',
  pt: 'pt', por: 'pt', portuguese: 'pt', portugisisk: 'pt',
  la: 'la', lat: 'la', latin: 'la',
}

function cleanToken(token: string): string {
  return token.trim().toLowerCase().replace(/^\/languages\//, '')
}

// Resolve one token to a known ISO code, or null if unknown. Handles multi-word
// BookWyrm values like "Norwegian nynorsk" or "Norsk bokmål" by also trying each
// whitespace/punctuation-separated word.
function mapLangToken(token: string): string | null {
  const t = cleanToken(token)
  if (!t) return null
  if (LANGUAGE_MAP[t]) return LANGUAGE_MAP[t]
  for (const word of t.split(/[\s_/-]+/)) {
    if (LANGUAGE_MAP[word]) return LANGUAGE_MAP[word]
  }
  return null
}

/**
 * Normalize a language value (string, array of strings, or OpenLibrary language
 * objects) to a single ISO-639-1 code where known. Returns the first token that
 * resolves to a known code; for a language outside our table it falls back to the
 * first non-empty token lower-cased, rather than dropping it.
 */
export function normalizeLanguage(value: unknown): string | null {
  const tokens: string[] = []
  const collect = (v: unknown) => {
    if (typeof v === 'string') tokens.push(v)
    else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).key === 'string')
      tokens.push((v as Record<string, string>).key)
  }
  if (Array.isArray(value)) value.forEach(collect)
  else collect(value)

  let fallback: string | null = null
  for (const tok of tokens) {
    const mapped = mapLangToken(tok)
    if (mapped) return mapped // first token that resolves to a known ISO code wins
    if (fallback == null) {
      const raw = cleanToken(tok)
      if (raw) fallback = raw
    }
  }
  return fallback
}
