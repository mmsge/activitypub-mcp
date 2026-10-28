import { describe, it, expect } from 'vitest'
import { decodeXmlText, parseViaductGpx } from './parse-viaduct-gpx.js'

// Trimmed from a real "viaduct routes, all years" export (2026-10-28). The first leg's
// segments are deliberately left in viaduct's order, which is not travel order.
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="viaduct" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>viaduct routes, all years</name>
  </metadata>
  <wpt lat="52.22882069741439" lon="21.003160000000005">
    <name>Warszawa Centralna</name>
  </wpt>
  <wpt lat="53.28" lon="-3.57">
    <name>Abergele &amp; Pensarn</name>
  </wpt>
  <trk>
    <name>Warszawa Centralna → Praha hl.n.</name>
    <desc>2016-07-04 21:30 · trip 1321316</desc>
    <trkseg>
      <trkpt lat="50.10069" lon="14.50231"/>
      <trkpt lat="50.08294" lon="14.43596"/>
    </trkseg>
    <trkseg>
      <trkpt lat="50.07702" lon="14.77059"/>
      <trkpt lat="50.07617" lon="14.75665"/>
      <trkpt lat="50.07128" lon="14.73455"/>
    </trkseg>
  </trk>
  <trk>
    <name>Oslo S → Bergen</name>
    <desc>2021-09-26 23:25 · trip 1735507</desc>
    <trkseg>
      <trkpt lat="59.91427" lon="10.64429"/>
      <trkpt lat="59.91361" lon="10.63708"/>
    </trkseg>
  </trk>
</gpx>
`

describe('parseViaductGpx', () => {
  const { tracks, waypoints, problems } = parseViaductGpx(GPX)

  it('reads one track per leg, keyed on viaduct’s trip id', () => {
    expect(problems).toEqual([])
    expect(tracks.map((t) => t.viaductTripId)).toEqual(['1321316', '1735507'])
  })

  it('splits the name into the two stations, spelled as the CSV spells them', () => {
    expect(tracks[0].fromStation).toBe('Warszawa Centralna')
    expect(tracks[0].toStation).toBe('Praha hl.n.')
  })

  it('keeps the desc time as the local wall clock, in the CSV parser’s format', () => {
    // 21:30 in Warsaw; the stored trip departs 19:30Z. No zone is applied here.
    expect(tracks[0].departureLocal).toBe('2016-07-04 21:30:00')
  })

  it('keeps every segment, in the order delivered, as [lon, lat]', () => {
    expect(tracks[0].segments).toHaveLength(2)
    expect(tracks[0].segments[0][0]).toEqual([14.50231, 50.10069])
    expect(tracks[0].segments[1]).toHaveLength(3)
    expect(tracks[0].pointCount).toBe(5)
  })

  it('reads the waypoints and decodes their entities', () => {
    expect(waypoints).toHaveLength(2)
    expect(waypoints[0]).toEqual({ name: 'Warszawa Centralna', lat: 52.22882069741439, lon: 21.003160000000005 })
    expect(waypoints[1].name).toBe('Abergele & Pensarn')
  })

  it('reports a track it cannot read instead of guessing', () => {
    const out = parseViaductGpx(`<gpx>
      <trk><name>Nowhere</name><desc>2020-01-01 10:00 · trip 1</desc>
        <trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk>
      <trk><name>A → B</name><desc>sometime</desc>
        <trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk>
      <trk><name>A → B</name><desc>2020-01-01 10:00 · trip 2</desc>
        <trkseg><trkpt lat="1" lon="1"/></trkseg></trk>
    </gpx>`)
    expect(out.tracks).toEqual([])
    expect(out.problems.map((p) => p.reason)).toEqual([
      'name is not "From → To"',
      'desc is not "YYYY-MM-DD HH:MM · trip N": sometime',
      'no segment with two or more points',
    ])
  })

  it('drops an out-of-range point rather than storing it', () => {
    const out = parseViaductGpx(`<gpx><trk><name>A → B</name><desc>2020-01-01 10:00 · trip 3</desc>
      <trkseg><trkpt lon="1" lat="1"/><trkpt lat="91" lon="2"/><trkpt lat="3" lon="3"/></trkseg></trk></gpx>`)
    expect(out.tracks[0].segments).toEqual([[[1, 1], [3, 3]]])
  })

  it('refuses a file that is not GPX at all', () => {
    expect(() => parseViaductGpx('from_station_name,to_station_name\n')).toThrow(/not a GPX/)
  })
})

describe('decodeXmlText', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeXmlText('Dunkeld &amp; Birnam &#233; &#xE9;')).toBe('Dunkeld & Birnam é é')
  })
})
