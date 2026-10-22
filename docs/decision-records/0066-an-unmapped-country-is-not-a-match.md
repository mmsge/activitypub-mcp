# 0066 — An unmapped country is not a match

**Status:** Accepted
**Date:** 2026-10-22
**Topics:** trains, geocoding, timezones, weather
**Contributors:** Markus (asked & decided: refuse hits in countries the geocoder keeps no
zone for, with tests for Bangor, Tirano and Falkenberg) + Claude (found the cause in the
re-geocode report, added the exact-name rule, implemented)

**Affects:** `src/lib/geocode-station.ts`, `src/lib/geocode-station.test.ts`,
`src/lib/__fixtures__/nominatim-2026-10-22.json`, `AGENTS.md`

Amends ADR 0065; 0065 stays as written.

## Context

The first real run of `npm run regeocode-stations` after ADR 0065 fixed 18 stations and
broke or kept wrong three, all in the trips archive:

- **Bangor** (UK rail 2023) moved from Wales to Bangor, Maine. Nominatim ranks Maine first
  (importance 0.552 against Wales' 0.547).
- **Tirano** (the Bernina Express from Chur) stayed in Tiranë, Albania, which Nominatim
  ranks above Tirano for the bare name.
- **Falkenberg** (Halmstad C → Falkenberg) stayed at Faulquemont in Moselle, whose German
  name is Falkenberg and which Nominatim ranks first.

The first two came through a gap in `offsetAgrees`: a hit in a country with no entry in
`COUNTRY_TZ` passed the clock check unconditionally, so a leg recorded in `Europe/London`
accepted the United States and a `Europe/Paris` leg accepted Albania. Falkenberg is a
different case: France keeps the same clock as Sweden, so no clock check can tell them
apart.

## Decision

- **With a known leg zone, a hit in a country `COUNTRY_TZ` does not list is refused**, and
  so is a hit with no country at all. The table is the list of countries this archive
  reaches; anything outside it is a namesake, not the station. An unknown leg zone (null,
  or the parser's `UTC` fallback) still accepts anything.
- **Monaco, Andorra, San Marino and the Vatican join the table**, so stations such as
  Monaco - Monte Carlo keep resolving. Albania and the Americas stay out on purpose.
- **A hit whose own OSM name is the station's name comes first** (`preferExactName`), case
  and diacritics folded, otherwise in Nominatim's order. Nominatim also matches alternative
  names, which is how Faulquemont outranks Falkenberg; the exact name restores Sweden as
  the bare name's country, and the existing rule then finds Falkenberg's station there.
  When no hit is named exactly like the query ("Malmö C" against "Malmö centralstation"),
  the order is untouched.

The tests run `geocodeStation` end to end against Nominatim's real answers for the three
stations, saved on 2026-10-22, and fail on the previous code.

## Consequences

- A station in a country the trips have never reached misses (keeps its old coordinates,
  or none) until its country is added to `COUNTRY_TZ`. A miss is visible in the re-geocode
  report; a wrong country was not.
- The exact-name rule can change which country an existing station resolves to when its
  bare top hit was an alternative-name match. The re-geocode report's dry run shows any
  such move before anything is written.
- The three stations are already pinned by hand (`source = 'manual'`) on the box, so this
  change protects the next station, not those three.
