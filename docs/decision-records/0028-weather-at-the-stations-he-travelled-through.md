# 0028 — The weather at the stations he travelled through

- **Status:** Accepted, partly amended
- **Amended by:** [0035](0035-drop-the-country-hint-and-check-geocodes-against-the-distances.md) — the country-hint premise below is wrong (viaduct.world records the UTC *offset* zone, not the station's), and the hint has been removed. Everything else here stands.
- **Date:** 2026-08-05
- **Contributors:** Markus (asked for the weather join, deferred through three earlier records, and chose to do it now) + Claude (proposed the two-table split, implemented the geocoding and the archive fetch)
- **Affects:** `drizzle/0025_station_weather.sql`, `src/db/schema.ts`, `src/lib/geocode-station.ts`, `src/lib/fetch-weather.ts`, `src/lib/weather-code.ts`, `src/jobs/sync-stations.ts`, `src/jobs/sync-station-weather.ts`, `src/mcp/tools/trip-weather.ts`, `src/stream/query.ts`, `src/rest/table.ts`
- **Topics:** trains, weather, geocoding, enrichment, postgres

## Context

The archive can say Markus took the Bergensbanen on 5 June 2026, which posts he
made from it, and which journey it belonged to. It could not say it was raining.

This was named as deferred work in ADR 0023 and again in 0024 — both times because
it is the only part of this line of work that needs an **external call**. The trip
data comes from a CSV he exports; the post↔trip join is pure derivation over data
already held. Weather is neither.

Two sources make it possible without an API key or an account:

- **Nominatim** (OpenStreetMap) turns a station name into coordinates.
- **Open-Meteo's ERA5 archive** gives daily weather back to 1940, comfortably
  covering a rail history that starts in 2016.

## Decision

**Two tables, because they fail separately.** `stations` holds the one-off geocode;
`station_weather` holds one row per (station, date). A station that will not
geocode must not keep re-requesting weather, and a weather outage must not cost us
the coordinates.

### Precision is not the problem; country is

ERA5 is a reanalysis on a **~25 km grid** — the API visibly snaps a request for
Bergen station (60.389, 5.333) to the cell at (60.422, 5.294). So landing in the
right *town* is as good as landing on the right platform, and a bare name lookup
is entirely adequate. No gazetteer, no station database, no per-station fiddling.

What does matter is which country. "Bergen" is Norwegian and Dutch; "Malmö C" is a
local abbreviation. The trips already carry the answer: viaduct.world records an
**IANA timezone per station**, so `Europe/Stockholm` says Sweden before any lookup
happens. That hint costs nothing and was already in the table.

**The hint is a bias, not a filter.** A miss retries unqualified — the timezone is
the station's, not necessarily its country's, and the CSV parser falls back to
`'UTC'` when a zone is absent, which must mean "unknown" rather than a country.
Verified against exactly that case: Åndalsnes searched as Danish returns nothing
and is found on the retry, at Rauma in Møre og Romsdal.

### Dates are local, not UTC

The date asked of the archive is `departure_local::date` at the origin and
`arrival_local::date` at the destination — both already columns. A night train
arriving at 06:20 therefore reports the morning it arrived rather than the evening
it left, and the fetch passes `timezone=auto` so the archive buckets its days the
same way.

### Only the days he was there

One request per station covers its whole span, because the archive returns a date
range in one response — ~115 requests for the entire backfill instead of one per
(station, date). But only the dates the trips actually name are stored. Keeping
the full span would turn a 229-trip history into a decade of daily weather for 115
places, most of it about days nobody was anywhere.

### A gap is never a zero

Weather is null wherever the station is not geocoded, the date is still inside the
archive's lag, or ERA5 simply has no value. `parseArchive` drops an all-null day
rather than storing it, `weatherLabel` returns null for a code it does not know
instead of guessing, and the stream omits the line entirely. Meanwhile a genuine
`0` — no rain, or 0°C — is kept, because on these trips both are real readings.

## Consequences

- The archive answers a question it could not before: *"what was the weather on
  the Bergensbanen that day?"* — light rain, 16°C leaving Oslo S, 14.2°C and
  10.7 mm arriving in Bergen, as verified against the live archive.
- `get_trip_weather` (and `/api/v1/trip-weather`) filter by condition in Nynorsk,
  by temperature range, and by the usual journey/station/operator facets. Trip
  entries on meg.msge.no gain "🌧️ regn · 12°".
- **Every response states coverage.** A thin result then reads as "not fetched
  yet" rather than "he never travelled in the rain" — which matters most in the
  days after deploy, while the bounded backfill is still running.
- The backfill is deliberately slow: 20 stations per run at one Nominatim request
  a second, 25 stations per weather run. 115 stations finish over a few scheduler
  ticks, or immediately with `npm run sync-weather` run repeatedly. Nominatim's
  usage policy is the constraint, and it is honoured rather than raced.
- **A wrong geocode is visible, not silent.** `display_name` stores what Nominatim
  actually matched and `get_trip_weather` returns it as
  `departure_station_matched`, so "Bergen, Nordrhein-Westfalen" would be obvious.
  Setting `source = 'manual'` pins a corrected row against re-geocoding.
- A name that misses three times is left alone rather than retried forever. It
  stays visible as `pending` in the job's log.
- Two new outbound dependencies, both keyless, both free, neither on a request
  path — they run in the scheduler, and every failure is non-fatal and retried.
- ERA5's ~7-day lag means recent trips gain weather about a week late. Those dates
  are counted as `tooRecent` rather than stored as nulls, so they are picked up
  later instead of being permanently blank.
- Verified by execution against Postgres 16 with all 26 migrations **and against
  both live APIs**: 10 of 10 real station names geocoded to the right country, and
  the stored days match the travel dates exactly rather than the requested span.
