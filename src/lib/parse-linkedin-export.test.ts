// The TOP POSTS sheet is two independent rankings printed side by side, and this
// is the file that has to know it. The left block is ranked by engagements and is
// ~14 rows deep; the right is ranked by impressions and is ~50 deep. A post sits
// at a DIFFERENT row position in each, so reading the sheet as one table pairs
// every post's impressions with some other post's engagements — plausible numbers,
// wrong post, no error anywhere.
//
// The fixture below is built so that a row-index join would produce specific wrong
// answers, and each is asserted against. See ADR 0033.
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseLinkedinExport, LinkedinExportError } from './parse-linkedin-export.js'
import type { LinkedinExport } from './parse-linkedin-export.js'

const urn = (id: string) => `https://www.linkedin.com/feed/update/urn:li:activity:${id}`
const permalink = (slug: string, id: string) =>
  `https://www.linkedin.com/posts/markus-mg_${slug}-ugcPost-${id}-aB1c`

const P1 = '7462903540748034001'
const P2 = '7462903540748034002'
const P3 = '7462903540748034003'
const P4 = '7462903540748034004'
const P5 = '7462903540748034005'

/**
 * A workbook shaped like the real export: a title row, then a header row, then two
 * blocks separated by a blank column, of different depths and different orderings.
 */
async function fixture(
  opts: { withSeries?: boolean; topPostsName?: string } = {},
): Promise<ArrayBuffer> {
  const { withSeries = true, topPostsName = 'TOP POSTS' } = opts
  const wb = new ExcelJS.Workbook()

  const top = wb.addWorksheet(topPostsName)
  top.getRow(1).getCell(1).value = 'Top posts'
  const header = top.getRow(2)
  header.getCell(1).value = 'Post URL'
  header.getCell(2).value = 'Post publish date'
  header.getCell(3).value = 'Engagements'
  // Column 4 is the blank gutter between the two blocks.
  header.getCell(5).value = 'Post URL'
  header.getCell(6).value = 'Post publish date'
  header.getCell(7).value = 'Impressions'

  // Left block — ranked by engagements, 3 rows deep.
  const byEngagement: [string, string, number][] = [
    [urn(P3), '2026-05-04', 61],
    [urn(P1), '2026-05-01', 51],
    // Same post as the right block's row 4, but spelled as a permalink.
    [permalink('sognacon', P5), '2026-05-11', 35],
  ]
  byEngagement.forEach(([url, date, eng], i) => {
    const row = top.getRow(3 + i)
    row.getCell(1).value = url
    row.getCell(2).value = date
    row.getCell(3).value = eng
  })

  // Right block — ranked by impressions, 5 rows deep, different order.
  const byImpressions: [string, string, number][] = [
    [urn(P1), '2026-05-01', 2408],
    [urn(P5), '2026-05-11', 1830],
    [urn(P2), '2026-05-02', 1625],
    [urn(P3), '2026-05-04', 900],
    [urn(P4), '2026-05-06', 540],
  ]
  byImpressions.forEach(([url, date, imp], i) => {
    const row = top.getRow(3 + i)
    row.getCell(5).value = url
    row.getCell(6).value = date
    // P1's impressions arrive as a formula, as the real export does for some cells.
    row.getCell(7).value =
      i === 0 ? ({ formula: 'SUM(H3:H4)', result: imp } as ExcelJS.CellFormulaValue) : imp
  })

  if (withSeries) {
    const eng = wb.addWorksheet('Engagement')
    eng.getRow(1).getCell(1).value = 'Engagement'
    eng.getRow(2).getCell(1).value = 'Date'
    eng.getRow(2).getCell(2).value = 'Impressions'
    const days = ['2026-05-01', '2026-05-14', '2026-05-31', '2026-05-07']
    days.forEach((d, i) => {
      eng.getRow(3 + i).getCell(1).value = d
      eng.getRow(3 + i).getCell(2).value = 100 + i
    })
  }

  return (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer
}

const byKey = (r: LinkedinExport, key: string) => r.metrics.find((m) => m.postKey === key)!

describe('parseLinkedinExport — the two-block join', () => {
  it('joins the blocks on post URL, not on row position', async () => {
    const r = await parseLinkedinExport(await fixture())

    // P3 is row 1 of the engagements block and row 4 of the impressions block.
    // A row-index join would hand it 2408 impressions (the value sitting on the
    // same row, which belongs to P1).
    const p3 = byKey(r, P3)!
    expect(p3.engagements).toBe(61)
    expect(p3.impressions).toBe(900)
    expect(p3.impressions).not.toBe(2408)

    // P5 is row 3 of the engagements block and row 2 of the impressions block.
    const p5 = byKey(r, P5)!
    expect(p5.engagements).toBe(35)
    expect(p5.impressions).toBe(1830)
    expect(p5.impressions).not.toBe(1625)
  })

  it('joins across the two URL spellings — the blocks do not agree on form', async () => {
    const r = await parseLinkedinExport(await fixture())

    // P5 is a permalink on the left and a URN on the right. Joining on the raw
    // string would produce two rows, each half-populated.
    const p5 = r.metrics.filter((m) => m.postKey === P5)
    expect(p5).toHaveLength(1)
    expect(p5[0].engagements).toBe(35)
    expect(p5[0].impressions).toBe(1830)
  })

  it('reads each block to its own depth', async () => {
    const r = await parseLinkedinExport(await fixture())
    // 5 distinct posts across a 3-row block and a 5-row block.
    expect(r.metrics).toHaveLength(5)
    expect(new Set(r.metrics.map((m) => m.postKey)).size).toBe(5)
  })

  it('leaves engagements null for a post outside the engagements block', async () => {
    const r = await parseLinkedinExport(await fixture())

    for (const key of [P2, P4]) {
      const m = byKey(r, key)!
      expect(m.engagements).toBeNull()
      expect(m.impressions).toBeGreaterThan(0)
    }
  })

  it('resolves formula cells to their value, not their formula string', async () => {
    const r = await parseLinkedinExport(await fixture())
    const p1 = byKey(r, P1)!

    expect(p1.impressions).toBe(2408)
    expect(typeof p1.impressions).toBe('number')
  })

  it('carries the publish date through', async () => {
    const r = await parseLinkedinExport(await fixture())
    expect(byKey(r, P3)!.postedOn).toBe('2026-05-04')
    expect(byKey(r, P4)!.postedOn).toBe('2026-05-06')
  })

  it('keeps the source cells in raw', async () => {
    const r = await parseLinkedinExport(await fixture())
    expect(byKey(r, P3)!.raw).toMatchObject({ Engagements: 61, Impressions: 900 })
  })
})

describe('parseLinkedinExport — the export window', () => {
  it('dates the export from the last day of the series, not from the clock', async () => {
    const r = await parseLinkedinExport(await fixture())

    // The series rows are deliberately out of order in the fixture.
    expect(r.windowStart).toBe('2026-05-01')
    expect(r.windowEnd).toBe('2026-05-31')
    expect(r.exportDate).toBe('2026-05-31')
  })

  it('derives the same export date every time, so re-importing one file is a no-op', async () => {
    const buf = await fixture()
    const a = await parseLinkedinExport(buf)
    const b = await parseLinkedinExport(buf)
    expect(a.exportDate).toBe(b.exportDate)
  })

  it('falls back to a supplied date only when the file has no series', async () => {
    const buf = await fixture({ withSeries: false })
    const r = await parseLinkedinExport(buf, { fallbackExportDate: '2026-06-30' })

    expect(r.exportDate).toBe('2026-06-30')
    expect(r.windowEnd).toBeNull()
    expect(r.metrics).toHaveLength(5)
  })

  it('refuses to guess when there is neither a series nor a supplied date', async () => {
    const buf = await fixture({ withSeries: false })
    await expect(parseLinkedinExport(buf)).rejects.toBeInstanceOf(LinkedinExportError)
  })
})

describe('parseLinkedinExport — rejecting the wrong file', () => {
  it('names the sheets it did find when Top Posts is missing', async () => {
    const buf = await fixture({ topPostsName: 'Followers' })
    await expect(parseLinkedinExport(buf)).rejects.toThrow(/Top Posts/i)
  })

  it('rejects something that is not a workbook at all', async () => {
    await expect(parseLinkedinExport(Buffer.from('post_url,impressions\n')))
      .rejects.toBeInstanceOf(LinkedinExportError)
  })
})
