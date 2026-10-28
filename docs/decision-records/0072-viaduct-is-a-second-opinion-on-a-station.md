# 0072 — viaduct is a second opinion on a station

**Status:** Accepted
**Date:** 2026-10-28
**Topics:** trains, geocoding, stations, viaduct
**Contributors:** Markus (decided: a tool, an admin page and a one-click pin, flagging at
5 km) + Claude (proposed and implemented)

**Affects:** `src/mcp/tools/station-discrepancies.ts`, `src/jobs/pin-station.ts`,
`src/admin/views/stations.tsx`, `src/admin/router.tsx`, `src/admin/views/layout.tsx`,
`src/mcp/server.ts`, `src/rest/table.ts`, `docs/openapi.yaml`

## Context

Every station's position comes from Nominatim, and ADRs 0065 and 0066 are a record of how
that goes wrong: Bergen in Picardy, Bangor in Maine. Each fix so far was found by a person
noticing. ADR 0070 stored viaduct.world's own waypoint for every station it has placed,
which is an independent answer to the same question, and it kept them apart from
`stations` on purpose.

## Decision

**Compare, never merge.** `get_station_discrepancies` (and `/api/v1/station-discrepancies`,
and **Admin → Stations**) compares every station a trip names with viaduct's waypoint of the
same exact name. When viaduct has two waypoints for one name, the nearest one counts: if
either agrees, the station is fine. A station `min_km` or more away is listed (default
5 km, `SAME_PLACE_KM`: wrong towns, not wrong platforms), as are stations the geocoder never
placed and stations viaduct has no waypoint for.

**The pin is the fix, and it is a manual pin.** The admin page posts one of viaduct's own
waypoints back, and the server refuses any coordinate that is not a stored waypoint of that
exact name, so the form cannot place a station anywhere else. The row becomes
`source = 'manual'`, which ADR 0065 already makes untouchable by the scheduler and by
`regeocode-stations`.

**A real move clears what described the wrong place.** At `SAME_PLACE_KM` or more, the
country, its zone and the stored weather days are dropped: all three were derived from the
place the geocoder chose. The weather is fetched again at the new position. The country
stays empty, since there is no reverse lookup, so the trip API falls back to the leg's zone
for that station, as it did before ADR 0065.

## Consequences

- The geocoder's mistakes become a list instead of a discovery.
- A station whose name differs between the CSV and the waypoints is listed under "no
  waypoint" and cannot be pinned from here. The fix for it is the usual manual edit.
