// Ask LinkedIn's DMA Member Snapshot endpoint directly and print exactly what
// comes back, without the crawl loop or the classifier standing in front of it.
//
// This exists because establishing what this source was actually doing previously
// required a hand-written curl loop over eight domains (ADR 0034), and then took
// several more days to notice it needed doing again — the poller reported success,
// `last_status` and `last_error` were null because only failures ever wrote them,
// and the interval is 168 hours, so there was nothing to look at and no way to
// look sooner. This is the "look sooner" (ADR 0039).
//
// Read-only: it makes GET requests and writes nothing to the database. Safe to run
// against production, and it never prints the token.
//
//   npm run probe-linkedin                       # the diagnostic domain set
//   npm run probe-linkedin -- --domain ARTICLES  # one domain (repeatable)
//   npm run probe-linkedin -- --all              # every domain LinkedIn documents
//   npm run probe-linkedin -- --no-domain        # one query across all domains
//   npm run probe-linkedin -- --start 3          # a specific page index
//   npm run probe-linkedin -- --full             # untruncated bodies
//   npm run probe-linkedin -- --json out.json    # the whole run as JSON
import { writeFile } from 'node:fs/promises'
import { config } from '../src/config.js'
import { probeSnapshotDomain } from '../src/lib/fetch-linkedin-snapshot.js'
import {
  ALL_DOMAINS,
  DEFAULT_DOMAINS,
  classify,
  verdictLine,
  type Probe,
  type ProbeVerdict,
} from '../src/lib/linkedin-probe.js'

/** Polite gap between probes; this is a diagnostic, not a crawler. */
const DELAY_MS = 300
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** How much of a body is printed without `--full`. */
const PREVIEW = 1200

function parseArgs(argv: string[]) {
  const domains: string[] = []
  let all = false
  let noDomain = false
  let start = 0
  let full = false
  let json: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--domain' || a === '-d') domains.push(argv[++i])
    else if (a === '--all') all = true
    else if (a === '--no-domain') noDomain = true
    else if (a === '--start') start = Number(argv[++i])
    else if (a === '--full') full = true
    else if (a === '--json') json = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: npm run probe-linkedin -- [--domain X]… [--all] [--no-domain] [--start N] [--full] [--json out.json]',
      )
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }

  if (!Number.isInteger(start) || start < 0) {
    console.error('--start must be a non-negative integer page index (it is a PAGE index, not an offset)')
    process.exit(2)
  }

  const list: (string | null)[] = all
    ? [...ALL_DOMAINS]
    : domains.length > 0
      ? domains
      : noDomain
        ? []
        : [...DEFAULT_DOMAINS]
  if (noDomain) list.unshift(null)

  return { domains: list, start, full, json }
}

const SYMBOL: Record<ProbeVerdict, string> = {
  data: '✓ data',
  no_data: '· none',
  unauthorized: '✗ AUTH',
  version: '✗ VERSION',
  error: '✗ error',
  unreadable: '✗ body',
}

// Arguments first, so `--help` answers even on a box with no token configured.
const { domains, start, full, json } = parseArgs(process.argv.slice(2))

const token = config.LINKEDIN_DMA_TOKEN.trim()
if (!token) {
  console.error('LINKEDIN_DMA_TOKEN is not set — nothing to probe.')
  process.exit(1)
}

console.log(`Probing ${domains.length} domain(s) at page index ${start}, Linkedin-Version 202312\n`)

const probes: Probe[] = []
for (const domain of domains) {
  const trace = await probeSnapshotDomain(token, domain, start)
  const probe = classify(trace)
  probes.push(probe)

  const label = (domain ?? '(all domains)').padEnd(24)
  const keys = probe.keys.length > 0 ? `  keys: ${probe.keys.slice(0, 3).join(', ')}` : ''
  console.log(
    `${label} ${String(probe.status).padStart(3)}  ${SYMBOL[probe.verdict].padEnd(10)}` +
      ` items: ${String(probe.items).padStart(4)}  ${probe.durationMs}ms${keys}`,
  )
  await sleep(DELAY_MS)
}

console.log(`\n${verdictLine(probes)}\n`)

console.log('--- raw responses -------------------------------------------------------')
for (const p of probes) {
  const body =
    full || p.body.length <= PREVIEW
      ? p.body
      : `${p.body.slice(0, PREVIEW)}… [${p.body.length} bytes, --full for all]`
  const id = p.requestId ? `  x-li-uuid: ${p.requestId}` : ''
  console.log(`\n### ${p.domain ?? '(all domains)'}  HTTP ${p.status}${id}`)
  console.log(body)
}

if (json) {
  await writeFile(json, JSON.stringify({ start, probedAt: new Date().toISOString(), probes }, null, 2))
  console.log(`\nWrote ${json}`)
}

// A refused token is the one outcome a caller (or a cron) should be able to act on
// without reading the output.
process.exit(probes.some((p) => p.verdict === 'unauthorized') ? 1 : 0)
