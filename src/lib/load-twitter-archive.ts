import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccount, parseYtd, type TwitterAccount } from './parse-twitter-archive.js'

/**
 * Read an unzipped Twitter archive from disk: the account and every tweet.
 *
 * Kept apart from src/jobs/import-twitter-archive.ts so a tool that only reads the
 * archive (scripts/recover-legacy-images.ts) runs without a database or app config.
 */

type AnyObject = Record<string, unknown>

export interface LoadedArchive {
  dir: string
  account: TwitterAccount
  tweets: AnyObject[]
  /** Names under `data/tweet_media/`. */
  tweetMedia: Set<string>
  /** Names under `data/profile_media/`. */
  profileMedia: Set<string>
}

const readYtd = (path: string): unknown[] | undefined => {
  if (!existsSync(path)) return undefined
  return parseYtd(readFileSync(path, 'utf8'))
}

const listDir = (path: string): Set<string> => (existsSync(path) ? new Set(readdirSync(path)) : new Set())

/** `tweet.js`, or `tweets.js` and `tweets-partN.js` in the archives that split it. */
export function tweetFileNames(dataFiles: Iterable<string>): string[] {
  return [...dataFiles]
    .filter((f) => /^tweets?(?:-part\d+)?\.js$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export function loadArchive(dir: string): LoadedArchive {
  const data = join(dir, 'data')
  if (!existsSync(join(data, 'account.js'))) {
    throw new Error(`${dir} is not a Twitter archive: data/account.js is missing`)
  }

  const account = parseAccount({
    account: readYtd(join(data, 'account.js')) ?? [],
    profile: readYtd(join(data, 'profile.js')),
    screenNameChange: readYtd(join(data, 'screen-name-change.js')),
    accountTimezone: readYtd(join(data, 'account-timezone.js')),
    verified: readYtd(join(data, 'verified.js')),
  })

  const files = tweetFileNames(readdirSync(data))
  if (files.length === 0) throw new Error(`${dir} holds no tweet.js`)

  const tweets: AnyObject[] = []
  const seen = new Set<string>()
  for (const f of files) {
    for (const entry of readYtd(join(data, f)) ?? []) {
      const tweet = (entry as AnyObject).tweet as AnyObject | undefined
      if (!tweet) continue
      // A partial archive can repeat a tweet across parts; one row per id, first seen.
      const id = typeof tweet.id_str === 'string' ? tweet.id_str : ''
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      tweets.push(tweet)
    }
  }

  return {
    dir,
    account,
    tweets,
    tweetMedia: listDir(join(data, 'tweet_media')),
    profileMedia: listDir(join(data, 'profile_media')),
  }
}

