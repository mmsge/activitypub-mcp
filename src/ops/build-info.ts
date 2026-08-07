import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * The slug this deployable answers to.
 *
 * One container, two sites: bot.skvip.lol (actor/admin/MCP) and meg.msge.no (the
 * public stream). `/version` is a property of the *image*, and there is exactly one
 * image, one commit and one `/srv/bot` behind both hosts — so the slug names the
 * deployable, not either domain. See ADR 0032; it must match SLUG in
 * scripts/generate-build-info.sh.
 */
export const SLUG = 'bot'

export interface BuildInfo {
  service: string
  commit: string | null
  commit_short: string | null
  branch: string | null
  commit_time: string | null
  repo: string | null
  dirty: boolean | null
  built_at: string | null
  source: 'build-info' | 'unknown'
}

const BASE: BuildInfo = {
  service: SLUG,
  commit: null,
  commit_short: null,
  branch: null,
  commit_time: null,
  repo: null,
  dirty: null,
  built_at: null,
  source: 'unknown',
}

/**
 * Where the deploy script's output lands.
 *
 * The Dockerfile copies build-info.json to the WORKDIR (/app) as its last COPY, and
 * this module is /app/src/ops/build-info.ts — hence `../..`. There is no build step
 * (the image runs the TypeScript through tsx), so the same relative path works in a
 * checkout. The cwd candidate is the fallback for anything started from elsewhere.
 */
function candidates(): string[] {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [join(here, '..', '..', 'build-info.json'), join(process.cwd(), 'build-info.json')]
}

/**
 * Read the git identity baked into the image at deploy time.
 *
 * An absent file is NOT an error: the box contract says report `source: "unknown"`
 * with null fields rather than 500 or guess. A guess here is worse than nothing —
 * the whole point of /version is telling "the checkout moved but the image didn't"
 * apart from "everything is current", and a fabricated SHA silently destroys that.
 */
export function loadBuildInfo(): BuildInfo {
  for (const path of candidates()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...BASE, ...(parsed as Partial<BuildInfo>), source: 'build-info' }
    }
  }
  return { ...BASE }
}

/** Loaded once at boot — the file cannot change without a new image. */
export const BUILD_INFO: BuildInfo = loadBuildInfo()
