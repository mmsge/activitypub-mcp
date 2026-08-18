import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { config, getRaceMilestones } from '../config.js'
import {
  artistEntity, entityLabel, raceEntitySchema, sameEntity,
  type RaceEntity, type RaceSide,
} from './race-entity.js'
import { logger } from './logger.js'

/**
 * Race definitions, read from a JSON file in the repo rather than from environment
 * variables.
 *
 * The race used to be exactly two env vars, RACE_LEADER_ARTIST and
 * RACE_CHALLENGER_ARTIST. That could express one race between two artists and nothing
 * else — not a second race, not an album side, and not a side that folds several
 * Last.fm album rows into one. See decision record 0051.
 *
 * The brief for this work specified races.toml parsed with `tomllib`. That is Python;
 * this is a TypeScript repo with no TOML parser anywhere, and the file is small
 * structured config — exactly what JSON.parse + zod already does for every other
 * setting here. Same schema, no new dependency.
 */

/** The file's own shape. Optional knobs fall back to the RACE_* / NTFY_TOPIC env
 *  defaults, so a race only has to say what it does differently. */
const raceFileEntrySchema = z.object({
  // Lowercase kebab: the id is a log field, a REST query param and the state table's key.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and hyphens'),
  title: z.string().min(1),
  topic: z.string().min(1).optional(),
  milestones: z.array(z.number().int().positive()).optional(),
  endgame_gap: z.number().int().min(0).optional(),
  nowplaying_gap: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
  leader: raceEntitySchema,
  challenger: raceEntitySchema,
  // Optional display names. Derived from the entity when absent — which reads well for
  // "The Good Witch vs Florescence" and badly for a cross-artist album race, where you
  // want the artist in front of the record.
  leader_label: z.string().min(1).optional(),
  challenger_label: z.string().min(1).optional(),
})

const racesFileSchema = z.object({
  races: z.array(raceFileEntrySchema).min(1),
}).loose() // tolerate a "$comment" key alongside "races"

/** A race, with every knob resolved. */
export interface RaceDefinition {
  id: string
  title: string
  topic: string
  /** Descending gap values that each fire a one-off milestone alert. */
  milestones: number[]
  endgameGap: number
  nowplayingGap: number
  /** Resolved: the race is over. Still queryable; both notifier jobs skip it. */
  archived: boolean
  leader: RaceSide
  challenger: RaceSide
}

export class RacesConfigError extends Error {}

/**
 * Validate a parsed races file. Pure — throws rather than exiting, so the tests can
 * assert on the message without taking the runner down with them.
 */
export function parseRaces(raw: unknown): RaceDefinition[] {
  const parsed = racesFileSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new RacesConfigError(`invalid race definitions — ${detail}`)
  }

  // Ids are the state key and the tool's handle on a race, so a duplicate is not a
  // cosmetic problem: two races would share one race_state row and overwrite each
  // other's fired milestones. zod cannot express uniqueness, so it is checked here.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const r of parsed.data.races) {
    if (seen.has(r.id)) duplicates.add(r.id)
    seen.add(r.id)
  }
  if (duplicates.size) {
    throw new RacesConfigError(
      `duplicate race id ${[...duplicates].map(id => `"${id}"`).join(', ')}`,
    )
  }

  for (const r of parsed.data.races) {
    // A race against itself sits at a gap of 0 forever: it would seed as a dead heat,
    // never resolve, and announce nothing but its own reflection.
    if (sameEntity(r.leader, r.challenger)) {
      throw new RacesConfigError(`race "${r.id}" races a side against itself`)
    }
    // Not fatal, but almost always a mistake: an artist side contains its own albums, so
    // every play on the narrower side is counted on the wider one too and the gap can
    // only ever widen.
    if (
      r.leader.artist === r.challenger.artist
      && (r.leader.type === 'artist') !== (r.challenger.type === 'artist')
    ) {
      logger.warn(
        { race: r.id },
        'Race side overlaps the other: one side is the whole artist and the other a subset of it',
      )
    }
  }

  return parsed.data.races.map(r => ({
    id: r.id,
    title: r.title,
    topic: r.topic ?? config.NTFY_TOPIC,
    // Descending, like getRaceMilestones() returns — decideRaceAlert reads the list as
    // a ladder and tightestCrossed takes the minimum, so order is presentation, but a
    // race that listed them ascending should still read the same way everywhere else.
    milestones: [...new Set(r.milestones ?? getRaceMilestones())].sort((a, b) => b - a),
    endgameGap: r.endgame_gap ?? config.RACE_COUNTDOWN_GAP,
    nowplayingGap: r.nowplaying_gap ?? config.RACE_NOWPLAYING_GAP,
    archived: r.archived ?? false,
    leader: side(r.leader, r.leader_label, r.challenger),
    challenger: side(r.challenger, r.challenger_label, r.leader),
  }))
}

/** A side's display name: the given label, else the entity's own names — qualified with
 *  the artist only when the two sides are by different artists, where "Florescence"
 *  alone would not say whose. */
function side(entity: RaceEntity, label: string | undefined, other: RaceEntity): RaceSide {
  if (label) return { label, entity }
  const own = entityLabel(entity)
  const qualify = entity.type !== 'artist' && entity.artist !== other.artist
  return { label: qualify ? `${entity.artist} — ${own}` : own, entity }
}

/** Read and validate the races file. Throws; `getRaces()` is what exits. */
export function loadRaces(path: string = config.RACES_CONFIG_PATH): RaceDefinition[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new RacesConfigError(`cannot read ${path}: ${(e as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new RacesConfigError(`${path} is not valid JSON: ${(e as Error).message}`)
  }
  return parseRaces(raw)
}

let cached: RaceDefinition[] | null = null

/**
 * The configured races, read once.
 *
 * A bad file exits the process, exactly as an invalid environment does in config.ts.
 * Booting with no races and one warning line would be the worse failure: the race jobs
 * are chained inside a try/catch that logs and continues, so the service would come up
 * looking healthy while nothing was being watched. Call this EARLY in src/index.ts,
 * before that block, so the crash happens where somebody can read it.
 */
export function getRaces(): RaceDefinition[] {
  if (cached) return cached
  try {
    cached = loadRaces()
  } catch (e) {
    console.error(`Invalid race definitions: ${(e as Error).message}`)
    process.exit(1)
  }
  return cached
}

/** Test seam: drop the memoised file so a fixture can be loaded in its place. */
export function resetRacesCache(): void {
  cached = null
}

export function getRace(id: string): RaceDefinition | null {
  return getRaces().find(r => r.id === id) ?? null
}

/** Every race the notifier should actually watch. */
export function activeRaces(): RaceDefinition[] {
  return getRaces().filter(r => !r.archived)
}

/** The race a caller gets when it names none: the first unresolved one. */
export function defaultRace(): RaceDefinition | null {
  return activeRaces()[0] ?? null
}

/** An artist-vs-artist race built on the fly, for ad-hoc queries and the legacy env
 *  bridge. It has no id, so nothing persists notifier state against it. */
export function adHocRace(leader: RaceEntity, challenger: RaceEntity): RaceDefinition {
  const l = side(leader, undefined, challenger)
  const c = side(challenger, undefined, leader)
  return {
    id: '',
    title: `${l.label} vs ${c.label}`,
    topic: config.NTFY_TOPIC,
    milestones: getRaceMilestones(),
    endgameGap: config.RACE_COUNTDOWN_GAP,
    nowplayingGap: config.RACE_NOWPLAYING_GAP,
    archived: false,
    leader: l,
    challenger: c,
  }
}

let deprecationLogged = false

/**
 * The retired RACE_LEADER_ARTIST / RACE_CHALLENGER_ARTIST pair, honoured for one
 * release when nothing else names a race. Resolves to the CONFIGURED race with those
 * two artists when there is one, so the deployment keeps its stored state and its
 * spent milestones instead of silently starting a second, identical race.
 */
export function legacyEnvRace(): RaceDefinition | null {
  const leader = config.RACE_LEADER_ARTIST.trim()
  const challenger = config.RACE_CHALLENGER_ARTIST.trim()
  if (!leader || !challenger || leader === challenger) return null

  if (!deprecationLogged) {
    deprecationLogged = true
    logger.warn(
      { leader, challenger, file: config.RACES_CONFIG_PATH },
      'RACE_LEADER_ARTIST/RACE_CHALLENGER_ARTIST are deprecated — move the race into races.json',
    )
  }

  const isArtist = (s: RaceSide, name: string) =>
    s.entity.type === 'artist' && s.entity.artist === name
  const configured = getRaces().find(
    r => isArtist(r.leader, leader) && isArtist(r.challenger, challenger),
  )
  return configured ?? adHocRace(artistEntity(leader), artistEntity(challenger))
}

export { raceEntitySchema, type RaceEntity, type RaceSide } from './race-entity.js'
