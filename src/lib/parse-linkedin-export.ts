import ExcelJS from 'exceljs'
import { normaliseKey } from './linkedin-keys.js'
import { canonicalPostKey } from './linkedin-url.js'

/**
 * Parse the monthly LinkedIn analytics .xlsx into per-post metric rows.
 *
 * Pure: takes bytes, returns rows, touches neither the network nor the database —
 * mirroring parse-trips-csv.ts, whose importer this one's importer also mirrors.
 *
 * The file has five sheets (Discovery, Engagement, Followers, Top Posts,
 * Demographics). Only TOP POSTS carries per-post numbers, and it is the one part
 * of this job that silently produces wrong data if skimmed:
 *
 *   **TOP POSTS is two independent rankings printed side by side, not one table.**
 *   A left block ranked by engagements (~14 rows deep) and a right block ranked by
 *   impressions (~50 rows deep), each with its own Post URL and publish date. A
 *   post sits at different row positions in the two, so reading them as one table
 *   pairs each post's impressions with a *different post's* engagements. The join
 *   is on the post URL, never on row index.
 *
 * See ADR 0033.
 */

/** Blank rows inside a block before we call it finished. */
const MAX_BLANK_RUN = 3
/** How far down to hunt for the header row; LinkedIn puts a title above it. */
const HEADER_SEARCH_ROWS = 12

export interface LinkedinMetricRow {
  postKey: string
  postUrl: string
  /** Publish date from the sheet, `YYYY-MM-DD`. The export carries no publish time. */
  postedOn: string | null
  impressions: number | null
  /** Null when the post appeared only in the impressions block. Never a guess. */
  engagements: number | null
  raw: Record<string, unknown>
}

export interface LinkedinExport {
  /** The export's identity, for the (post, export) dedupe key. */
  exportDate: string
  windowStart: string | null
  windowEnd: string | null
  metrics: LinkedinMetricRow[]
}

type Cell = ExcelJS.Cell

/**
 * A cell's value with formulas resolved.
 *
 * ExcelJS hands a formula cell back as `{ formula, result }`; taking `.value`
 * naively would store the string "=SUM(B2:B15)" where a number belongs. Shared
 * formulas, rich text, hyperlinks and error cells all need unwrapping too.
 */
function cellValue(cell: Cell | undefined): unknown {
  const v = cell?.value
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return v
  if (v instanceof Date) return v

  const o = v as unknown as Record<string, unknown>
  // Formula and shared-formula cells: the cached result is the value.
  if ('result' in o) return o.result ?? null
  // An error cell (#REF!, #N/A) is missing data, not a value.
  if ('error' in o) return null
  if ('richText' in o) {
    return (o.richText as { text: string }[]).map((t) => t.text).join('')
  }
  if ('text' in o) return o.text
  return null
}

function cellText(cell: Cell | undefined): string | null {
  const v = cellValue(cell)
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * A URL cell, preferring the hyperlink target over the display text — LinkedIn
 * sometimes writes a shortened label over the real permalink, and the label has no
 * id in it to join on.
 */
function cellUrl(cell: Cell | undefined): string | null {
  const v = cell?.value as unknown as Record<string, unknown> | undefined
  if (v && typeof v === 'object' && typeof v.hyperlink === 'string') return v.hyperlink.trim()
  const link = (cell as unknown as { hyperlink?: string })?.hyperlink
  if (typeof link === 'string' && link.trim() !== '') return link.trim()
  return cellText(cell)
}

function cellNumber(cell: Cell | undefined): number | null {
  const v = cellValue(cell)
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null
  // Thousands separators and stray percent signs come through on text-formatted cells.
  const n = Number(String(v).replace(/[\s ,]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

/** A date cell as `YYYY-MM-DD`, read in UTC so the calendar day cannot drift. */
function cellDate(cell: Cell | undefined): string | null {
  const v = cellValue(cell)
  if (v === null || v === undefined) return null

  if (v instanceof Date) return v.toISOString().slice(0, 10)

  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)

  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function findSheet(wb: ExcelJS.Workbook, ...names: string[]): ExcelJS.Worksheet | null {
  const wanted = names.map(normaliseKey)
  return wb.worksheets.find((ws) => wanted.includes(normaliseKey(ws.name))) ?? null
}

interface HeaderRow {
  rowNumber: number
  /** Column index → normalised header label. */
  labels: Map<number, string>
}

/** Find the row that actually carries column headings, matching `predicate`. */
function findHeaderRow(
  ws: ExcelJS.Worksheet,
  predicate: (label: string) => boolean,
): HeaderRow | null {
  const lastRow = Math.min(ws.rowCount, HEADER_SEARCH_ROWS)
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r)
    const labels = new Map<number, string>()
    let hit = false
    for (let c = 1; c <= row.cellCount; c++) {
      const label = cellText(row.getCell(c))
      if (!label) continue
      const norm = normaliseKey(label)
      labels.set(c, norm)
      if (predicate(norm)) hit = true
    }
    if (hit) return { rowNumber: r, labels }
  }
  return null
}

interface Block {
  urlCol: number
  dateCol: number | null
  impressionsCol: number | null
  engagementsCol: number | null
  /** Original header text per column, for `raw`. */
  headers: Map<number, string>
}

/**
 * Split the TOP POSTS header into its side-by-side blocks.
 *
 * Every `Post URL` column starts a block; the block owns the columns up to the
 * next `Post URL` (or the end of the row). Derived from the header rather than
 * hardcoded to two blocks at fixed letters, so a fifth column or a reordered
 * export does not quietly shift the numbers by one.
 */
function splitBlocks(header: HeaderRow, ws: ExcelJS.Worksheet): Block[] {
  const urlCols = [...header.labels.entries()]
    .filter(([, label]) => label === 'posturl' || label === 'postlink')
    .map(([col]) => col)
    .sort((a, b) => a - b)

  const headerRow = ws.getRow(header.rowNumber)
  const lastCol = Math.max(headerRow.cellCount, ...header.labels.keys())

  return urlCols.map((urlCol, i) => {
    const end = i + 1 < urlCols.length ? urlCols[i + 1] - 1 : lastCol
    const block: Block = {
      urlCol,
      dateCol: null,
      impressionsCol: null,
      engagementsCol: null,
      headers: new Map(),
    }
    for (let c = urlCol; c <= end; c++) {
      const label = header.labels.get(c)
      if (!label) continue
      block.headers.set(c, cellText(headerRow.getCell(c)) ?? label)
      if (label.includes('publishdate') || label === 'postdate' || label === 'date') {
        block.dateCol ??= c
      } else if (label.includes('impression')) {
        block.impressionsCol ??= c
      } else if (label.includes('engagement')) {
        block.engagementsCol ??= c
      }
    }
    return block
  })
}

/**
 * The reporting window, from the daily series on the Engagement or Discovery
 * sheet. Used to date the export deterministically: keying on a date the uploader
 * typed would let the same file import twice under two keys, which is exactly the
 * duplication the (post, export date) unique index exists to prevent.
 */
function readWindow(wb: ExcelJS.Workbook): { start: string | null; end: string | null } {
  for (const name of ['Engagement', 'Discovery']) {
    const ws = findSheet(wb, name)
    if (!ws) continue
    const header = findHeaderRow(ws, (l) => l === 'date')
    if (!header) continue
    const dateCol = [...header.labels.entries()].find(([, l]) => l === 'date')?.[0]
    if (!dateCol) continue

    const dates: string[] = []
    for (let r = header.rowNumber + 1; r <= ws.rowCount; r++) {
      const d = cellDate(ws.getRow(r).getCell(dateCol))
      if (d) dates.push(d)
    }
    if (dates.length === 0) continue

    dates.sort()
    return { start: dates[0], end: dates[dates.length - 1] }
  }
  return { start: null, end: null }
}

export class LinkedinExportError extends Error {}

/**
 * Parse a LinkedIn analytics export.
 *
 * `fallbackExportDate` is used only when the file carries no readable daily
 * series; the caller surfaces which one was used so a hand-dated import is
 * visible rather than assumed.
 */
export async function parseLinkedinExport(
  data: ArrayBuffer | Buffer,
  opts: { fallbackExportDate?: string } = {},
): Promise<LinkedinExport> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(data as ArrayBuffer)
  } catch (e) {
    throw new LinkedinExportError(`Not a readable .xlsx file: ${(e as Error).message}`)
  }

  const sheet = findSheet(wb, 'Top Posts', 'TOP POSTS', 'TopPosts')
  if (!sheet) {
    const names = wb.worksheets.map((w) => w.name).join(', ')
    throw new LinkedinExportError(
      `No "Top Posts" sheet in this workbook. Sheets found: ${names || '(none)'}`,
    )
  }

  const header = findHeaderRow(sheet, (l) => l === 'posturl' || l === 'postlink')
  if (!header) {
    throw new LinkedinExportError(
      'The "Top Posts" sheet has no "Post URL" column in its first rows — is this a Content export?',
    )
  }

  const blocks = splitBlocks(header, sheet)
  const byKey = new Map<string, LinkedinMetricRow>()

  for (const block of blocks) {
    let blanks = 0
    // Each block is walked to ITS OWN end. The blocks are different depths, so a
    // shared row cursor would truncate the deeper one or over-read the shallower.
    for (let r = header.rowNumber + 1; r <= sheet.rowCount && blanks < MAX_BLANK_RUN; r++) {
      const row = sheet.getRow(r)
      const url = cellUrl(row.getCell(block.urlCol))
      if (!url) {
        blanks++
        continue
      }
      blanks = 0

      const postKey = canonicalPostKey(url)
      if (!postKey) continue

      // Merge by post, NOT by row position: this lookup is the join.
      const existing = byKey.get(postKey)
      const entry: LinkedinMetricRow = existing ?? {
        postKey,
        postUrl: url,
        postedOn: null,
        impressions: null,
        engagements: null,
        raw: {},
      }

      if (block.dateCol) entry.postedOn ??= cellDate(row.getCell(block.dateCol))
      if (block.impressionsCol) {
        entry.impressions ??= cellNumber(row.getCell(block.impressionsCol))
      }
      if (block.engagementsCol) {
        entry.engagements ??= cellNumber(row.getCell(block.engagementsCol))
      }
      for (const [c, label] of block.headers) {
        entry.raw[label] ??= cellValue(row.getCell(c)) as never
      }

      byKey.set(postKey, entry)
    }
  }

  const window = readWindow(wb)
  const exportDate = window.end ?? opts.fallbackExportDate ?? null
  if (!exportDate) {
    throw new LinkedinExportError(
      'Could not read a reporting window from the Engagement or Discovery sheet, and no export date was supplied.',
    )
  }

  return {
    exportDate,
    windowStart: window.start,
    windowEnd: window.end,
    metrics: [...byKey.values()],
  }
}
