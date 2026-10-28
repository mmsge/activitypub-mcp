# 0070 — A route is its own import

**Status:** Accepted
**Date:** 2026-10-28
**Topics:** trains, viaduct, import, geometry
**Contributors:** Markus (asked for a GPX import kept apart from the CSV one, and decided:
store and match to trips, replace everything on re-import, keep the waypoints, expose it over
REST and MCP) + Claude (proposed the shape and implemented it)

**Affects:** `src/lib/parse-viaduct-gpx.ts`, `src/jobs/import-trip-tracks.ts`,
`src/mcp/tools/trip-tracks.ts`, `src/admin/router.tsx`, `src/admin/views/import.tsx`,
`src/db/schema.ts`, `drizzle/0045_trip_tracks.sql`, `src/mcp/server.ts`, `src/rest/table.ts`,
`docs/openapi.yaml`

## Context

viaduct.world exports two files. The CSV (ADR 0048) carries every attribute of a leg and no
geometry. The GPX, "viaduct routes, all years", carries the geometry and almost nothing else:

- one `<trk>` per leg, named `From → To`, with a desc of `YYYY-MM-DD HH:MM · trip N`;
- one or more `<trkseg>` per track, plain `lat`/`lon` points with no time and no elevation;
- one `<wpt>` per station viaduct has placed, sometimes two for one name metres apart.

The 2026-10-28 export holds 299 tracks, 117,437 points and 749 waypoints. The segments are
not in travel order: the first segment of Warszawa → Praha is the approach into Praha.

`trip N` is viaduct's own id. The CSV never exports it, so there is no shared key.

## Decision

**A separate upload, writing separate tables.** `trip_tracks` holds one row per track, keyed
on viaduct's trip id; `viaduct_waypoints` holds the waypoints. The GPX import never writes
`train_trips` or `stations`, and the CSV import never writes these. The two files are
exported and uploaded at different times, and one arriving must leave the other alone.

**The join is the trip's identity, read the way the GPX spells it.** The desc time is the
origin's wall clock, the same one the CSV's `departure_date`/`departure_time` carry, so a
track matches the trip with the same `from_station`, `to_station` and `departure_local`. No
zone is involved, which matters: viaduct's zones are per offset rule, not per station
(ADR 0065). Checked against the live archive: Warszawa Centralna 21:30 is stored as 19:30Z,
Paris Nord 09:03 as 07:03Z.

**At query time, not as a foreign key.** A stored `trip_id` would go stale the moment a trip
is pruned and re-entered (ADR 0054) and would never fill in for a GPX imported before its
CSV. `tripTrackMatchSql` is the one spelling of the join, shared by the import report and the
tool. An unmatched track is kept and listed, never dropped.

**The file is the complete set.** Markus chose replace-everything over upsert: a track or
waypoint the file no longer contains is deleted, so a leg deleted in viaduct loses its line
here too. Unlike the CSV prune there is no confirm step, because nothing else hangs off a
track. The one guard is that a file with no readable tracks is refused rather than read as
"delete everything". An unchanged re-import writes nothing.

**Geometry as delivered.** `segments` is GeoJSON MultiLineString coordinates, `[lon, lat]`,
segment order untouched. Reordering into a path would be a guess presented as data.

**Waypoints beside `stations`, never over them.** `stations` is what Nominatim answered and
what an admin pinned; `viaduct_waypoints` is what viaduct believes. They can be compared
later, and a manual pin must never be overwritten by an upload.

**Served as GeoJSON.** `get_trip_tracks` and `/api/v1/trip-tracks` return a FeatureCollection,
one Feature per leg, with the joined CSV trip's fields as properties (null when unmatched)
and a `coverage` block, filterable by trip id, viaduct id, journey, station, year and
matched. `with_geometry=false` lists what has a route without the coordinates.

## Consequences

- No webhook fires. Nothing downstream reads geometry yet, and ADR 0053 is clear that a
  wake nobody listens for is noise.
- A GPX newer than the CSV leaves its newest legs unmatched until the next CSV import, which
  joins them without re-uploading the GPX. The result page says so.
- The waypoints are an obvious second opinion for the geocoder's misses (ADR 0065, 0066),
  but using them is a separate decision.
