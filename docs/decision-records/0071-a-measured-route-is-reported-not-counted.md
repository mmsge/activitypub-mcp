# 0071 — A measured route is reported, not counted

**Status:** Accepted
**Date:** 2026-10-28
**Topics:** trains, viaduct, geometry, distance
**Contributors:** Markus (decided: report the measured length only, never fill a missing
distance in a total) + Claude (proposed and implemented)

**Affects:** `src/lib/geo-distance.ts`, `src/jobs/import-trip-tracks.ts`,
`src/mcp/tools/train-trips.ts`, `src/mcp/tools/trip-tracks.ts`, `src/db/schema.ts`,
`drizzle/0046_trip_track_measured_km.sql`, `docs/openapi.yaml`

## Context

ADR 0070 stored the line each leg drew. Its length is a second measurement of the leg,
beside the `distance_km` viaduct exports in the CSV. Some legs have no `distance_km` at all
(Helsingør → København on 2026-10-25), and every total that sums the column, the
convergence watcher among them, silently drops them.

## Decision

**`trip_tracks.measured_km` is the drawn length,** km to one decimal: each segment's points
summed by haversine, the gaps between segments never bridged. viaduct's segments are not in
travel order, so a gap is not a known distance. The importer computes it and migration 0046
backfilled the rows already stored with the same arithmetic in SQL.

**It is reported and nothing else.** `get_train_trips` carries `measuredKm` and
`get_trip_tracks` `measured_km`, beside the existing distance. No total, no stat and no
watcher reads it. Markus chose this over filling the missing distances: a measurement that
undercounts by its gaps, slipped into a sum, would change the convergence watcher's history
and every kilometre figure without anything on the page saying so.

## Consequences

- The two figures can be compared by eye or by a caller. A large gap between them points at a
  wrong route or a wrong distance.
- Legs with no `distance_km` still count zero in totals. Filling them is a separate decision,
  and would want the gap question settled first.
