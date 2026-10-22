# 0065 — A timezone names a clock, not a country

**Status:** Accepted
**Date:** 2026-10-22
**Topics:** trains, geocoding, timezones, weather, viaduct
**Contributors:** Markus (built reise.msge.no on the trip coordinates and noticed the
forecasts were French) + Claude (traced the cause and implemented the fix)

**Affects:** `src/lib/geocode-station.ts`, `src/jobs/sync-stations.ts`,
`src/jobs/regeocode-stations.ts`, `scripts/regeocode-stations.ts`,
`drizzle/0044_station_timezone.sql`, `src/db/schema.ts`, `src/mcp/tools/train-trips.ts`,
`docs/openapi.yaml`

Supersedes the *"Precision is not the problem; country is"* section of ADR 0028.

## Context

ADR 0028 took a station's country from the trip's IANA zone: `Europe/Stockholm` says
Sweden, so search Nominatim with `countrycodes=se` first. PR #137 put the stored zones and
coordinates on `get_train_trips`, and the first consumer, reise.msge.no, found that most of
them are wrong:

- `fromTz`/`toTz` is `Europe/Paris` for Bergen, Oslo S, Göteborgs central, Praha hl.n.,
  Stockholm Central and nearly everything else. Only the UK stations are `Europe/London`.
- So the country hint was `fr` for all of them. Where France had a namesake, the
  "bias" won: Bergen at 49.98, 2.92 (Picardy), Oslo S in Strasbourg, Malmö C in Rennes,
  Lund C in Burgundy, Arna near Nice, Ål in Paris. Paris Nord landed on a hamlet in
  Haute-Garonne. The stations that came out right were the ones with no French namesake,
  found on the unbiased retry.

Every `get_trip_weather` answer for those stations has been ERA5 weather in France.

**The zones come from viaduct.world's export itself, not from the importer.** Both saved
exports on disk (`livsdata` and `mardata`) carry `from_station_tz = Europe/Paris` for every
CET station and `Europe/London` for every UK one, 166 rows against 32 and nothing else.
Viaduct records one zone per UTC offset rule, not per station. The instants are right,
because Paris and Oslo keep the same clock, which is why nothing failed until something
read the zone as a place.

## Decision

**The leg's zone is an offset and only ever used as one.** The geocoder no longer
restricts or biases its search by country. It searches the bare name unrestricted and
drops any hit in a country whose clock disagrees with the leg's (winter and summer offsets
compared through `Intl`). `Europe/Paris` therefore accepts Norway, Sweden and Czechia, and
refuses London, which is the only thing it can honestly say. `UTC`, the parser's fallback
for a missing zone, still means "unknown".

**Prefer a railway station, and let the bare name pick its country.** With no country
filter, "Bergen station" ranks Mons first (Bergen is its Dutch name), and bare "Paris Nord"
is the hamlet. So:

1. If the bare name's first hit is a railway station, it wins. Oslo S, Malmö C, Lund C,
   Göteborgs central and Praha hl.n. all land here.
2. Otherwise search `"<name> station"` and take the first station in the country the bare
   name pointed to (Bergen → Norway → Bergen stasjon; Paris Nord → France → Gare du Nord).
3. Otherwise keep the bare name's hit: the right town is enough for weather.

All 18 stations from the bug report were checked live against Nominatim after the change.
Every one lands in the right place.

**The station carries its true zone; the leg keeps Viaduct's.** `stations.timezone` is
derived from the geocoded country (a country → zone table; never the other way round).
`train_trips.from_tz`/`to_tz` stay verbatim. `departure_at` was computed from them, and the
next CSV import would write them back anyway. The trip API returns
`coalesce(station.timezone, trip.from_tz)`, so `fromTz` is `Europe/Oslo` for Bergen once
it is re-geocoded, and Viaduct's offset-correct zone until then.

**Repair is a script run by hand, not a scheduled job.** `npm run regeocode-stations`
re-geocodes every non-manual station, prints old → new with the distance moved, and drops
the stored weather of any station that moved 5 km or more so `sync-weather` refetches it.
A miss keeps the old coordinates. `--dry-run` writes nothing, and `--station NAME` narrows
the run. `source = 'manual'` rows are never re-geocoded. That remains the escape hatch for a
station Nominatim cannot be talked into, and the script only fills in their `timezone`
from the country already on the row.

## Consequences

- A geocode can no longer be steered into the wrong country by Viaduct's zone. The
  remaining failure mode is Nominatim ranking: a bare name whose top hit is a
  same-offset namesake that is not a station, with no station of that name in the
  country. The script's report is where that would show, and a manual row fixes it.
- Up to two Nominatim requests per station instead of one-then-maybe-two. At one a second
  this is a few minutes for the whole archive, and the scheduler's bounded bite is
  unchanged.
- Consumers of `fromTz`/`toTz` (reise.msge.no) get a zone that names the place once the
  repair has run. Anything that needs the zone the departure was *recorded* in should read
  `train_trips.from_tz` directly. Today nothing does.
- Rule not to "simplify" back: never turn `from_tz`/`to_tz` into a country. If a
  country hint is ever wanted again, it has to come from somewhere that names a place.
