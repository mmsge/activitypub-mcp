/**
 * Parse viaduct.world's "routes, all years" GPX export. See ADR 0070.
 *
 * The export is one `<trk>` per leg and a `<wpt>` per station:
 *
 *   <wpt lat="52.22" lon="21.00"><name>Warszawa Centralna</name></wpt>
 *   <trk>
 *     <name>Warszawa Centralna → Praha hl.n.</name>
 *     <desc>2016-07-04 21:30 · trip 1321316</desc>
 *     <trkseg><trkpt lat="50.10" lon="14.50"/>…</trkseg>
 *     …
 *   </trk>
 *
 * The desc time is the LOCAL wall clock at the origin, the same one the CSV export's
 * `departure_date`/`departure_time` carry, so it joins to `train_trips.departure_local`
 * without a zone. The trip number is viaduct's own id, which the CSV does not export.
 *
 * Points carry no time and no elevation, and the segments are not in travel order:
 * the first segment of Warszawa → Praha is the approach into Praha. They are kept as
 * delivered, a set of lines rather than a path.
 *
 * Hand-rolled rather than a dependency: the shape is fixed by one exporter, and the
 * four elements read here are all it has. Anything that does not fit is reported, not
 * guessed at.
 */

export interface GpxWaypoint {
  name: string
  lat: number
  lon: number
}

export interface GpxTrack {
  /** viaduct's trip id, from `trip NNN` in the desc. */
  viaductTripId: string
  fromStation: string
  toStation: string
  /** `YYYY-MM-DD HH:MM:00`, the origin's wall clock. Same format as the CSV parser's. */
  departureLocal: string
  /** One array per `<trkseg>`, each point `[lon, lat]` (GeoJSON order). */
  segments: [number, number][][]
  pointCount: number
}

export interface GpxProblem {
  /** The track's name, or its position when it has none. */
  track: string
  reason: string
}

export interface ViaductGpx {
  tracks: GpxTrack[]
  waypoints: GpxWaypoint[]
  problems: GpxProblem[]
}

const ARROW = ' → '
const DESC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · trip (\d+)$/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16))
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10))
    return ENTITIES[k] ?? m
  })
}

/** Text content of the first `<tag>` directly in `xml`, decoded, or null. */
function childText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? decodeXmlText(m[1]).trim() : null
}

/** `lat`/`lon` from an element's opening tag, in either order. Null if either is unusable. */
function latLon(openTag: string): { lat: number; lon: number } | null {
  const lat = /\slat="([^"]*)"/.exec(openTag)
  const lon = /\slon="([^"]*)"/.exec(openTag)
  if (!lat || !lon) return null
  const la = Number(lat[1])
  const lo = Number(lon[1])
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null
  return { lat: la, lon: lo }
}

/**
 * Parse the export. Throws only when the file is not a GPX document at all; a track
 * that cannot be read is listed in `problems` and left out.
 */
export function parseViaductGpx(text: string): ViaductGpx {
  if (!/<gpx[\s>]/.test(text)) throw new Error('File is not a GPX document (no <gpx> element)')

  const waypoints: GpxWaypoint[] = []
  for (const m of text.matchAll(/<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/g)) {
    const pos = latLon(m[1])
    const name = m[2] ? childText(m[2], 'name') : null
    if (!pos || !name) continue
    waypoints.push({ name, ...pos })
  }

  const tracks: GpxTrack[] = []
  const problems: GpxProblem[] = []
  let index = 0
  for (const m of text.matchAll(/<trk>([\s\S]*?)<\/trk>/g)) {
    index++
    const body = m[1]
    const name = childText(body, 'name')
    const label = name ?? `track #${index}`
    const desc = childText(body, 'desc')

    const parts = name?.split(ARROW) ?? []
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      problems.push({ track: label, reason: 'name is not "From → To"' })
      continue
    }
    const d = desc ? DESC.exec(desc) : null
    if (!d) {
      problems.push({ track: label, reason: `desc is not "YYYY-MM-DD HH:MM · trip N": ${desc ?? '(none)'}` })
      continue
    }

    const segments: [number, number][][] = []
    let pointCount = 0
    for (const s of body.matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/g)) {
      const points: [number, number][] = []
      for (const p of s[1].matchAll(/<trkpt\b([^>]*?)\/?>/g)) {
        const pos = latLon(p[1])
        if (pos) points.push([pos.lon, pos.lat])
      }
      // A line needs two points; a lone one draws nothing.
      if (points.length >= 2) {
        segments.push(points)
        pointCount += points.length
      }
    }
    if (segments.length === 0) {
      problems.push({ track: label, reason: 'no segment with two or more points' })
      continue
    }

    tracks.push({
      viaductTripId: d[3],
      fromStation: parts[0].trim(),
      toStation: parts[1].trim(),
      departureLocal: `${d[1]} ${d[2]}:00`,
      segments,
      pointCount,
    })
  }

  return { tracks, waypoints, problems }
}
