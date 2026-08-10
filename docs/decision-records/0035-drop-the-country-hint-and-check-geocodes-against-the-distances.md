# 0035 — Drop the country hint, and check geocodes against the distances travelled

- **Status:** Accepted
- **Supersedes:** the country-hint premise of [0028](0028-weather-at-the-stations-he-travelled-through.md); the rest of that record stands
- **Date:** 2026-08-06
- **Contributors:** Markus (ran the backfill, spotted the `Europe/Paris` timezones in the log and read them correctly as his own travels, then asked for all three fixes) + Claude (traced the wrong premise, measured the damage, proposed the distance check)
- **Affects:** `drizzle/0028_station_geocode_check.sql`, `src/lib/geocode-station.ts`, `src/lib/geo-distance.ts`, `src/jobs/check-station-geocodes.ts`, `src/jobs/reset-geocodes.ts`, `src/jobs/sync-stations.ts`, `src/mcp/tools/trip-weather.ts`
- **Topics:** trains, weather, geocoding, data-quality, incident

## Context

ADR 0028 biased each Nominatim lookup by the country the trip's IANA timezone
implied, on the stated premise that *"viaduct.world records an IANA timezone per
station, so `Europe/Stockholm` says Sweden before any lookup happens"*.

**The premise was wrong.** The first real backfill made that visible: every
fallback logged `countryCode: "fr"`, for Swedish Alvesta, Norwegian Dombås, Swiss
Basel SBB alike. The export's timezones are:

| `from_tz` | trips | span |
|---|---|---|
| `Europe/Paris` | 197 | 2016-07-04 → 2026-10-30 |
| `Europe/London` | 32 | 2023-07-12 → 2026-04-04 |

Two values across 229 trips, and **no `Europe/Oslo` at all** — for an archive
whose most-travelled line is the Bergensbanen. viaduct.world records the UTC
*offset* zone with one representative name per offset: `Europe/Paris` for CET,
so Norway, Sweden, Denmark, Germany, Switzerland, Belgium and the Netherlands all
read as France.

That is harmless for the trip times — CET is CET whatever it is called, so
`departure_at` was never affected. It is fatal as a country hint.

**And the failure was silent.** A wrong hint does not merely waste the first
request. Where the name also exists in the wrong country, the biased search
*succeeds*, so the unqualified fallback never runs. Six stations were placed in
France and their weather fetched from there:

| Station | Actually | Geocoded to |
|---|---|---|
| Arna | Bergen, Norway | Crête de Costa-d'Arna, **Nice** |
| Bergen | Vestland, Norway | Bouchavesnes-Bergen, **Somme** |
| Chur | Switzerland | Allée de Chur, **Normandie** |
| Falkenberg | Sweden | Faulquemont, **Moselle** |
| Halden | Norway | Halden, **Bas-Rhin** |
| Hede | Sweden | Hédé-Bazouges, **Bretagne** |

## Decision

**Three changes: remove the hint, redo the work, and check the result.**

### No country hint at all

Removed rather than corrected, because there is nothing to correct it with — the
archive holds no trustworthy country per station. Measured against the six
failures, an unqualified search fixes five: Arna → Norway, Bergen → Vestland,
Chur → Graubünden, Halden → Østfold, Hede → Sweden.

### Accept that a few will still be wrong

The sixth does not fix. "Falkenberg" fuzzy-matches Faulquemont in Moselle
whatever you ask. Adding `station` to the query fixes exactly that one — and
breaks `Bergen`, which then matches Mons in Belgium. `layer=railway` returns
nothing at all. There is no formulation that gets 115 out of 115, and pretending
otherwise is how the first version went wrong.

So the residual errors are **caught afterwards instead of prevented**.

### Check the coordinates against the distances travelled

The archive already knows how far apart two stations are: viaduct.world records
`distance_km` per leg, and **a straight line cannot be longer than the distance
travelled along it**. Where it appears to be, an endpoint is misplaced.

Arna→Bergen: 9 km recorded, 1,846 km of great circle. The check writes that
excess to `stations.geocode_error_km` — near zero or negative when the placement
is sane (Oslo S scores −179, since 484 km of track spans 305 km of air), large
when it is not. `get_trip_weather` returns it beside the weather it explains.

**It flags, it does not fix.** A leg cannot say *which* of its two endpoints is
wrong, so both are scored — Bergen carries Arna's 1,846 km too. That is honest
rather than clever, and the stored `display_name` settles it instantly for a
human: "Crête de Costa-d'Arna, Cantaron, Nice" against "Bergen, Vestland, Norge".
The correction is `source = 'manual'`, which the geocoder then never overwrites.

### Redo the work already done

Nothing distinguishes a station geocoded under the old rule from one geocoded
under the new one, so `npm run reset-geocodes` clears them all. It deletes the
weather for cleared stations too: it was measured at the wrong place, and the
weather job only fetches what is *missing*, so a stale row would never be
revisited. Manual rows are untouched — re-deriving over a human's correction
would undo the one escape hatch this design depends on.

## Consequences

- One Nominatim request per station instead of two, and no path where a wrong
  answer is accepted without a second look.
- The backfill restarts from zero for the ~30 stations already done. Cheap, and
  the alternative is six stations quietly reporting French weather forever.
- **A wrong geocode is now a number**, not something you would notice only by
  reading a weather report for the wrong country. `syncStations` runs the check
  after any batch that moved and logs the offenders at `warn`.
- Falkenberg — and anything else the geocoder is confidently wrong about — will
  still be wrong after this, but *visibly* wrong. That is the point.
- The tolerance is 100 km, deliberately generous: the job is catching stations on
  the wrong continent, not auditing metres. ERA5 reads the same ~25 km cell
  either way, so a small error is not worth a human's attention.
- A leg needs `distance_km` and both endpoints placed to be checkable. Legs
  without a recorded distance contribute nothing, so a station appearing only on
  those stays unscored — null, not zero.
- Verified against Postgres 16 with the real bad coordinates seeded: the check
  scores Arna at 1,846 km and leaves correctly-placed stations negative, the
  reset clears automatic rows and their weather while preserving manual ones, and
  the tool surfaces the error beside the weather.

## What this record does not change

Everything else in ADR 0028 stands: the two-table split, local calendar dates at
each end, storing only the days he travelled, and a gap never being a zero.
