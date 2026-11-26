// Build tiktok-archive.json from the TikTok archive on the Mac, ready for upload.
//
//   npm run build-tiktok-archive -- <archive-dir> [options]
//
//     <archive-dir>         the folder holding user_data_tiktok.json and meta/, e.g.
//                           ~/Jottacloud/TikTok
//     --export=<file>       the data export (default <archive-dir>/user_data_tiktok.json)
//     --meta=<dir>          yt-dlp's info.json files (default <archive-dir>/meta)
//     --out=<file>          where to write (default <archive-dir>/tiktok-archive.json)
//     --username=<name>     the account (default: yt-dlp's `uploader` on the newest video)
//     --display-name=<name> its display name (default: yt-dlp's `channel` on the newest video)
//     --examples=<n>        examples to print per report line (default 5)
//
// Runs on the Mac, where the archive is: neither the export nor the metadata leaves it.
// Upload the file it writes at Admin → Import → TikTok-arkiv, or import it on the server
// with npm run import-tiktok-archive.
//
// Reads TWO things only: Post.Posts.VideoList in the export, and the named fields of each
// info.json. Direct messages, searches, watch history and the rest of the export are never
// read, and the signed CDN links in it are never copied. Posts are paired on the exact
// second; see ADR 0078 for why there is no tolerance window.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  accountFromInfos,
  buildTiktokArchive,
  readExportPosts,
  readInfo,
  type InfoMeta,
} from '../src/lib/build-tiktok-archive.js'
import { parseTiktokArchive } from '../src/lib/parse-tiktok-archive.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const dirs = argv.filter((a) => !a.startsWith('--'))
if (dirs.length !== 1) {
  console.error('usage: npm run build-tiktok-archive -- <archive-dir> [--export=F] [--meta=D] [--out=F] [--username=U] [--display-name=N]')
  process.exit(2)
}
const dir = dirs[0]!
const exportPath = flag('export') ?? join(dir, 'user_data_tiktok.json')
const metaDir = flag('meta') ?? join(dir, 'meta')
const outPath = flag('out') ?? join(dir, 'tiktok-archive.json')
const examples = Number(flag('examples') ?? '5')
const n = (x: number) => x.toLocaleString('en-US')

try {
  console.log(`Reading ${exportPath}`)
  const { posts, badDates } = readExportPosts(JSON.parse(readFileSync(exportPath, 'utf8')))

  console.log(`Reading ${metaDir}`)
  const infos: InfoMeta[] = []
  const unreadable: string[] = []
  for (const name of readdirSync(metaDir).filter((f) => f.endsWith('.info.json')).sort()) {
    try {
      const meta = readInfo(JSON.parse(readFileSync(join(metaDir, name), 'utf8')))
      if (meta) infos.push(meta)
      else unreadable.push(name)
    } catch {
      unreadable.push(name)
    }
  }

  const fromInfos = accountFromInfos(infos)
  const username = flag('username') ?? fromInfos.username
  if (!username) throw new Error('No account name in the metadata: pass --username=<name>')
  const displayName = flag('display-name') ?? fromInfos.displayName ?? username

  const { archive, report } = buildTiktokArchive({ exportPosts: posts, badDates, infos, username, displayName, generatedAt: new Date() })

  // The file must be one the importer takes whole. Checked here, where it can be fixed.
  const { problems } = parseTiktokArchive(JSON.parse(JSON.stringify(archive)))
  if (problems.length > 0) {
    for (const p of problems.slice(0, examples)) console.error(`  post ${p.index} (${p.postedAt ?? '?'}): ${p.reason}`)
    throw new Error(`${problems.length} posts would be refused by the importer; nothing written`)
  }

  writeFileSync(outPath, `${JSON.stringify(archive, null, 2)}\n`)

  const first = archive.posts[0]?.postedAt.slice(0, 10) ?? '–'
  const last = archive.posts[archive.posts.length - 1]?.postedAt.slice(0, 10) ?? '–'
  console.log(`\n@${archive.account.username} (${archive.account.displayName})`)
  console.log(`  ${n(report.exportPosts)} posts in the export, ${first} → ${last}`)
  console.log(`  ${n(report.infos)} info.json files, ${n(report.matched)} paired on the exact second`)
  console.log(`  ${n(report.withoutMetadata.photo)} photo posts and ${n(report.withoutMetadata.video)} videos without metadata: date, likes and sound only`)
  if (report.badDates.length) {
    console.log(`  ${n(report.badDates.length)} export entries with a Date that could not be read, left out:`)
    for (const b of report.badDates.slice(0, examples)) console.log(`    #${b.index}: ${JSON.stringify(b.date)}`)
  }
  if (report.ambiguous.length) {
    console.log(`  ${n(report.ambiguous.length)} seconds hold more than one post or info.json, none of them paired:`)
    for (const a of report.ambiguous.slice(0, examples)) console.log(`    ${a.postedAt}: ${a.exportPosts} posts, info ${a.infos.join(', ')}`)
  }
  if (report.unmatchedInfos.length) {
    console.log(`  ${n(report.unmatchedInfos.length)} info.json files match no post in the export, not included:`)
    for (const u of report.unmatchedInfos.slice(0, examples)) console.log(`    ${u.id} at ${u.postedAt}`)
  }
  if (unreadable.length) {
    console.log(`  ${n(unreadable.length)} info.json files had no id or timestamp:`)
    for (const u of unreadable.slice(0, examples)) console.log(`    ${u}`)
  }
  console.log(`\nWrote ${outPath}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
