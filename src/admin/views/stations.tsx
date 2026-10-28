/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import type { getStationDiscrepancies, StationComparison } from '../../mcp/tools/station-discrepancies.js'

/**
 * Where viaduct.world and the geocoder disagree about a station, with a one-click pin to
 * viaduct's position. Same handler as `get_station_discrepancies`. See ADR 0072.
 */

type Report = Awaited<ReturnType<typeof getStationDiscrepancies>>

const osm = (lat: number, lon: number) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`

function Position({ lat, lon }: { lat: number | null; lon: number | null }) {
  if (lat == null || lon == null) return <span style="color:#555">—</span>
  return (
    <a href={osm(lat, lon)} target="_blank" rel="noopener" class="mono">
      {lat.toFixed(4)}, {lon.toFixed(4)}
    </a>
  )
}

function PinForm({ s }: { s: StationComparison }) {
  return (
    <form method="post" action="/admin/stations/pin" style="margin:0">
      <input type="hidden" name="name" value={s.name} />
      <input type="hidden" name="latitude" value={String(s.viaduct_latitude)} />
      <input type="hidden" name="longitude" value={String(s.viaduct_longitude)} />
      <button type="submit">Pin to viaduct</button>
    </form>
  )
}

function Rows({ rows, showDistance }: { rows: StationComparison[]; showDistance: boolean }) {
  // Its own horizontal scroller: six columns do not fit a phone, and the page must not.
  return (
    <div style="overflow-x: auto">
      <table>
        <thead>
          <tr>
            <th>Station</th>
            {showDistance && <th>Apart (km)</th>}
            <th>Stored</th>
            <th>Geocoder matched</th>
            <th>viaduct</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.name}>
              <td>
                {s.name}
                {s.source === 'manual' && <span class="badge" style="margin-left:6px">manual</span>}
              </td>
              {showDistance && <td class="mono">{s.distance_km}</td>}
              <td><Position lat={s.latitude} lon={s.longitude} /></td>
              <td style="color:#888">
                {s.display_name ?? '—'}
                {s.country_code ? ` (${s.country_code.toUpperCase()})` : ''}
              </td>
              <td><Position lat={s.viaduct_latitude} lon={s.viaduct_longitude} /></td>
              <td><PinForm s={s} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StationsPage({ report, notice, error }: { report: Report; notice?: string; error?: string }) {
  return (
    <Layout title="Stations">
      <h1>Stations</h1>
      {notice && <div class="notice" style="color:#4ade80;margin-bottom:16px">{notice}</div>}
      {error && <div class="error">{error}</div>}

      <div class="grid" style="margin-bottom: 24px;">
        <div class="card">
          <div class="num" style={report.disagreeing.length ? 'color: #fbbf24;' : 'color: #888;'}>
            {report.disagreeing.length}
          </div>
          <div class="label">{report.min_km} km or more from viaduct</div>
        </div>
        <div class="card">
          <div class="num" style="color: #4ade80;">{report.coverage.agreeing}</div>
          <div class="label">Agree with viaduct</div>
        </div>
        <div class="card">
          <div class="num" style="color: #888;">{report.not_geocoded.length}</div>
          <div class="label">Not geocoded, viaduct has a position</div>
        </div>
        <div class="card">
          <div class="num" style="color: #888;">{report.no_waypoint.length}</div>
          <div class="label">No viaduct waypoint by that name</div>
        </div>
      </div>

      <p style="color: #888; margin-bottom: 16px; line-height: 1.5;">
        Every station a trip names, compared with viaduct.world's own waypoint of the same name
        from the GPX import. Pinning moves the station to viaduct's position and marks it
        manual, so the geocoder never moves it back. A move of {report.min_km} km or more also
        clears the country and drops the stored weather, which belonged to the wrong place.
      </p>

      {report.coverage.viaduct_waypoints === 0 && (
        <div class="error">No viaduct waypoints stored. Import the GPX at Admin → Import first.</div>
      )}

      {report.disagreeing.length > 0 && (
        <div class="section">
          <h2>Disagreeing</h2>
          <Rows rows={report.disagreeing} showDistance={true} />
        </div>
      )}

      {report.not_geocoded.length > 0 && (
        <div class="section">
          <h2>Not geocoded</h2>
          <Rows rows={report.not_geocoded} showDistance={false} />
        </div>
      )}

      {report.no_waypoint.length > 0 && (
        <div class="section">
          <h2>No viaduct waypoint</h2>
          <p style="color: #888; line-height: 1.5;">{report.no_waypoint.join(' · ')}</p>
        </div>
      )}
    </Layout>
  )
}
