/**
 * Resolving what someone typed to a registry entry.
 *
 * Markus asks for a line the way it comes out of his mouth, which is not the way it
 * is spelled in a table: «Bergensbanen» one day, «bergensbana» the next, «Bergen
 * Line» when the conversation is in English. The Øresund bridge has a different
 * official spelling on each side of it — Öresundsbron in Sweden, Øresundsbroen in
 * Denmark, Øresundsbroa in Nynorsk — and none of them is wrong.
 *
 * So matching is case-blind, diacritic-blind, punctuation-blind, and blind to which
 * definite article a Scandinavian language happens to have glued on the end. The
 * aliases in the registry carry the rest; this file deliberately does no stemming
 * beyond the suffix table below, because guessing at morphology is how «Bergensbanen»
 * ends up matching «Bergenbahn».
 *
 * A name that resolves to nothing returns the nearest entries rather than an empty
 * result — a typo should be answerable, not a dead end.
 */

import { allEntries } from './railway-registry.js'

/**
 * Scandinavian definite endings, folded to a common stem so «-banen», «-bana» and
 * «-banan» are one word. Applied to the tail of the already-normalised string.
 */
const SUFFIXES: Array<[RegExp, string]> = [
  [/(banen|bana|banan|banene)$/, 'bane'],
  [/(broen|broa|bron|brua|broene)$/, 'bro'],
  [/(tunnelen|tunneln|tunnelet|tunnelene)$/, 'tunnel'],
  [/(linjen|linja|linjene)$/, 'linje'],
  [/(forbindelsen|forbindelse|sambandet)$/, 'samband'],
]

/** Letters that do not decompose under NFD and so need folding by hand. */
const LETTERS: Array<[RegExp, string]> = [
  [/ø/g, 'o'],
  [/æ/g, 'ae'],
  [/å/g, 'a'],
  [/ß/g, 'ss'],
  [/đ|ð/g, 'd'],
  [/ł/g, 'l'],
  [/þ/g, 'th'],
]

/**
 * Fold a name to its comparison key.
 *
 * Lowercase, strip accents, fold the letters NFD leaves alone, drop everything that
 * is not a letter or digit, then collapse the definite endings. «Öresundsbron»,
 * «Øresundsbroen» and «Öresundsbroa» all land on `oresundsbro`.
 */
export function normaliseLineName(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^the\s+/, '')
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  for (const [re, to] of LETTERS) s = s.replace(re, to)
  s = s.replace(/[^a-z0-9]/g, '')
  for (const [re, to] of SUFFIXES) {
    const folded = s.replace(re, to)
    if (folded !== s) return folded
  }
  return s
}

export interface ResolvedLine {
  slug: string
  name: string
  kind: 'line' | 'crossing'
  /** Which spelling matched — the canonical name, or the alias that got there. */
  matched: string
  /** 'exact' when a name or alias matched outright, 'prefix' when it was a stem. */
  via: 'exact' | 'prefix'
}

export interface LineSuggestion {
  slug: string
  name: string
  kind: 'line' | 'crossing'
}

/** Every spelling an entry answers to, canonical name first. */
function spellingsOf(entry: ReturnType<typeof allEntries>[number]): string[] {
  return [entry.name, entry.slug, ...entry.aliases]
}

/**
 * Resolve a typed name to one registry entry.
 *
 * Exact matches win over prefixes, and among prefixes the shortest entry name wins,
 * so «bergens» reaches Bergensbanen rather than whichever line was declared first.
 * Returns null when nothing is close enough to claim — ask `suggestLines` then.
 */
export function resolveLineName(input: string): ResolvedLine | null {
  const key = normaliseLineName(input)
  if (!key) return null

  const entries = allEntries()

  for (const entry of entries) {
    for (const spelling of spellingsOf(entry)) {
      if (normaliseLineName(spelling) === key) {
        return { slug: entry.slug, name: entry.name, kind: entry.kind, matched: spelling, via: 'exact' }
      }
    }
  }

  // A stem only counts from the start of a name: «bergens» is Bergensbanen, but
  // «banen» must not be, or every Norwegian line would answer to it.
  const prefixHits: Array<{ entry: (typeof entries)[number]; spelling: string }> = []
  for (const entry of entries) {
    for (const spelling of spellingsOf(entry)) {
      const norm = normaliseLineName(spelling)
      if (key.length >= 4 && norm.startsWith(key)) {
        prefixHits.push({ entry, spelling })
        break
      }
    }
  }
  if (prefixHits.length > 0) {
    prefixHits.sort((a, b) => a.entry.name.length - b.entry.name.length)
    const best = prefixHits[0]!
    return {
      slug: best.entry.slug,
      name: best.entry.name,
      kind: best.entry.kind,
      matched: best.spelling,
      via: 'prefix',
    }
  }

  return null
}

/** Levenshtein distance, iterative with a single row. Registry-sized inputs only. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    prev = row
  }
  return prev[b.length]!
}

/**
 * The nearest entries to a name that did not resolve.
 *
 * Scored on the best edit distance across all of an entry's spellings, relative to
 * length so a long name is not punished for being long. Always returns something
 * when the registry is non-empty: an unknown line should come back with "did you
 * mean" rather than silence.
 */
export function suggestLines(input: string, limit = 5): LineSuggestion[] {
  const key = normaliseLineName(input)
  if (!key) return []

  const scored = allEntries().map((entry) => {
    let best = Number.POSITIVE_INFINITY
    for (const spelling of spellingsOf(entry)) {
      const norm = normaliseLineName(spelling)
      // A containment either way is very close — «öresund» inside «öresundsbroa».
      const raw = norm.includes(key) || key.includes(norm)
        ? Math.abs(norm.length - key.length) / 2
        : editDistance(key, norm)
      best = Math.min(best, raw / Math.max(norm.length, key.length))
    }
    return { entry, score: best }
  })

  scored.sort((a, b) => (a.score - b.score) || a.entry.name.localeCompare(b.entry.name))
  return scored.slice(0, limit).map(({ entry }) => ({
    slug: entry.slug,
    name: entry.name,
    kind: entry.kind,
  }))
}
