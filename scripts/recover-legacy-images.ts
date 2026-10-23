// Recover the photos behind pre-2011 photo links (Twitpic, yfrog, Twitgoo, Plixi/Lockerz,
// early Instagram) in Twitter archive exports: from twitpic.com itself, which still serves
// them, and otherwise from the Wayback Machine. See ADR 0068.
//
//   npm run recover-legacy-images -- <archive-dir> [<archive-dir> …] [options]
//
//     <archive-dir>      an unzipped export, the folder holding `data/`. Same as
//                        import-twitter-archive takes.
//     --out=<dir>        where the pictures go (default ./legacy-images)
//     --dry-run          list the links found and stop; no network
//     --hosts=a,b        only these hosts: twitpic, yfrog, twitgoo, plixi, instagram
//     --limit=<n>        stop after looking up n links (handy for a first test run)
//     --delay=<ms>       wait between requests to archive.org (default 1500)
//     --retry-missing    look up links the last run recorded as missing
//
// Writes, under <out>:
//   <username>/<tweet date>_<tweet id>_<host>-<photo id>.<ext>   one file per tweet
//   index.csv     every link found, with tweet, status, file and where it came from
//                 (the live Twitpic page, or the Wayback capture)
//   state.json    what each link resolved to, so a re-run only looks up what is new
//
// Needs no database and no app config: it reads the archive folders and talks to
// web.archive.org, nothing else. Safe to stop and restart at any point.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadArchive } from '../src/lib/load-twitter-archive.js'
import { parseTwitterDate } from '../src/lib/parse-twitter-archive.js'
import { extensionFor, legacyLinksInTweet, type LegacyHost, type LegacyImageLink } from '../src/lib/legacy-image-links.js'
import { WaybackClient } from '../src/lib/wayback.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = (name: string): boolean => argv.includes(`--${name}`)

const dirs = argv.filter((a) => !a.startsWith('--'))
if (dirs.length === 0) {
  console.error('usage: npm run recover-legacy-images -- <archive-dir> [<archive-dir> …] [--out=D] [--dry-run] [--hosts=twitpic,yfrog] [--limit=N] [--delay=MS] [--retry-missing]')
  process.exit(2)
}

const ALL_HOSTS: LegacyHost[] = ['twitpic', 'yfrog', 'twitgoo', 'plixi', 'instagram']
const hosts = new Set((flag('hosts')?.split(',').map((h) => h.trim()) ?? ALL_HOSTS) as LegacyHost[])
for (const h of hosts) {
  if (!ALL_HOSTS.includes(h)) {
    console.error(`unknown host "${h}"; use ${ALL_HOSTS.join(', ')}`)
    process.exit(2)
  }
}
const out = flag('out') ?? './legacy-images'
const dryRun = has('dry-run')
const retryMissing = has('retry-missing')
const limit = flag('limit') ? Number(flag('limit')) : Infinity
const delayMs = Number(flag('delay') ?? '1500')

interface Use {
  username: string
  tweetId: string
  date: string | null
  tweetUrl: string
}
interface Found {
  link: LegacyImageLink
  uses: Use[]
}
interface StateEntry {
  status: 'found' | 'missing' | 'error'
  /** The file under <out> holding the picture, for a found link. */
  file?: string
  waybackUrl?: string
  via?: string
  error?: string
  checkedAt: string
}

// 1. Collect every link, keyed by its normalised URL so a photo linked twice is fetched once.
const links = new Map<string, Found>()
for (const dir of dirs) {
  const archive = loadArchive(dir)
  const username = archive.account.username
  let count = 0
  for (const tweet of archive.tweets) {
    const id = typeof tweet.id_str === 'string' ? tweet.id_str : String(tweet.id ?? '')
    for (const link of legacyLinksInTweet(tweet)) {
      if (!hosts.has(link.host)) continue
      count++
      const use: Use = {
        username,
        tweetId: id,
        date: parseTwitterDate(tweet.created_at),
        tweetUrl: `https://twitter.com/${username}/status/${id}`,
      }
      const entry = links.get(link.url) ?? { link, uses: [] }
      entry.uses.push(use)
      links.set(link.url, entry)
    }
  }
  console.log(`@${username}: ${count} legacy photo links in ${archive.tweets.length} tweets`)
}

const byHost = new Map<string, number>()
for (const { link } of links.values()) byHost.set(link.host, (byHost.get(link.host) ?? 0) + 1)
console.log(`${links.size} distinct photos: ${[...byHost].map(([h, n]) => `${h} ${n}`).join(', ') || 'none'}`)

if (dryRun) {
  for (const { link, uses } of links.values()) {
    for (const u of uses) console.log(`${u.date?.slice(0, 10) ?? '?'}\t@${u.username}\t${link.url}\t${u.tweetUrl}`)
  }
  process.exit(0)
}

// 2. Look each one up, resuming from the last run.
mkdirSync(out, { recursive: true })
const statePath = join(out, 'state.json')
const state: Record<string, StateEntry> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2))

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
const fileFor = (u: Use, link: LegacyImageLink, ext: string) =>
  join(safe(u.username), `${u.date?.slice(0, 10) ?? 'unknown'}_${u.tweetId}_${link.host}-${safe(link.id)}.${ext}`)

const client = new WaybackClient({ delayMs })
let looked = 0
const tally = { found: 0, missing: 0, error: 0, skipped: 0 }
let interrupted = false
process.on('SIGINT', () => {
  interrupted = true
  console.log('\nstopping after this lookup; run again to continue')
})

for (const { link, uses } of links.values()) {
  if (interrupted || looked >= limit) break
  const prev = state[link.url]
  const done = prev && (prev.status === 'found' ? existsSync(join(out, prev.file ?? '')) : prev.status === 'missing' && !retryMissing)
  if (done) {
    tally.skipped++
    continue
  }
  looked++
  const result = await client.recover(link)
  const at = new Date().toISOString()
  if (result.status === 'found') {
    const ext = extensionFor(result.contentType)
    const first = fileFor(uses[0], link, ext)
    mkdirSync(join(out, safe(uses[0].username)), { recursive: true })
    writeFileSync(join(out, first), result.bytes)
    // The same photo in more than one tweet gets a copy per tweet, so each tweet's
    // folder entry is complete on its own.
    for (const u of uses.slice(1)) {
      const f = fileFor(u, link, ext)
      mkdirSync(join(out, safe(u.username)), { recursive: true })
      if (!existsSync(join(out, f))) copyFileSync(join(out, first), join(out, f))
    }
    state[link.url] = { status: 'found', file: first, waybackUrl: result.waybackUrl, via: result.via, checkedAt: at }
    tally.found++
    console.log(`found    ${link.url}  ←  ${result.waybackUrl}`)
  } else if (result.status === 'missing') {
    state[link.url] = { status: 'missing', checkedAt: at }
    tally.missing++
    console.log(`missing  ${link.url}  (tried ${result.tried.length} URLs)`)
  } else {
    state[link.url] = { status: 'error', error: result.error, checkedAt: at }
    tally.error++
    console.log(`error    ${link.url}  ${result.error}`)
  }
  saveState()
}

// 3. The index covers every link found, including ones not looked up yet this run.
const csv = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`
const rows = ['username,tweet_id,tweet_date,tweet_url,host,photo_id,link,status,file,source_url']
for (const { link, uses } of links.values()) {
  const s = state[link.url]
  for (const u of uses) {
    const file = s?.status === 'found' ? fileFor(u, link, (s.file ?? '').split('.').pop() ?? 'bin') : ''
    rows.push([u.username, u.tweetId, u.date, u.tweetUrl, link.host, link.id, link.url, s?.status ?? 'pending', file, s?.waybackUrl].map(csv).join(','))
  }
}
writeFileSync(join(out, 'index.csv'), rows.join('\n') + '\n')

console.log(
  `\nlooked up ${looked}: ${tally.found} found, ${tally.missing} missing, ${tally.error} errors; ${tally.skipped} already done`,
)
console.log(`index: ${join(out, 'index.csv')}`)
if (tally.error > 0) process.exitCode = 1
