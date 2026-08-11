# 0035 — A curated kilometre post beats a geometry

- **Status:** Accepted
- **Date:** 2026-08-10
- **Contributors:** Markus (asked for line and crossing statistics, and chose curated kilometre posts over the PostGIS design he had sketched) + Claude (measured the registry against the export, wrote the attribution and the three tools)
- **Affects:** `drizzle/0028_trip_line_legs.sql`, `src/db/schema.ts`, `src/lib/railway-registry.ts`, `src/lib/line-name.ts`, `src/lib/line-attribution.ts`, `src/jobs/resolve-trip-lines.ts`, `src/mcp/tools/railway-lines.ts`, `src/rest/table.ts`
- **Topics:** trains, railway lines, crossings, curation, postgres

## Context

The archive could say Markus went from Bergen to Oslo S, how far it was and what the
weather was doing (ADR 0028). It could not say he went on **Bergensbanen**, because
nothing in the trip store knows a line exists. Answering "how many kilometres on
Bergensbanen?" meant guessing every station on the route, running one
`get_train_trips` call per station, deduplicating by hand and summing columns — and
still missing legs whose endpoints sit off the line. Fixed links were worse: nothing
recorded that a trip had crossed a bridge at all.

The obvious design is geometric: put PostGIS on the database, import an OSM rail
graph, route each station pair over real track, intersect the routes with each line's
geometry. That is what was sketched, and it is not what was built.

## Decision

**A line is an ordered list of stations with a kilometre position — the railway's own
kilometrering — and attribution is arithmetic over those numbers.** The registry lives
in git as `src/lib/railway-registry.ts`; only what it derives is stored.

### Why not the geometry

Three reasons, in the order they mattered.

**The coordinates are not good enough to route over.** `get_trip_weather` currently
reports `departure_station_matched` for "Oslo S" as *Rue d'Oslo, Strasbourg*, and for
"Malmö C" as *Allée de Malmoë, Rennes*. ADR 0028 kept `display_name` precisely so a
wrong geocode would be visible rather than silent, and here it is. Routing over those
points would produce confident nonsense, and the nonsense would be much harder to
spot inside a geometry than inside a number a human wrote.

**The scale does not need it.** 229 trips, 115 stations, 164 distinct station pairs.
Curating kilometre posts for that is a day's work and yields an answer that can be
checked line by line. An OSM import, a routing engine and a geometry cache is a
permanent piece of infrastructure to maintain in exchange for the same answer.

**It would cost a base-image change on a live shared host.** `postgres:16-alpine`
serves five services on one VPS. Swapping it for a PostGIS image is a real operation,
not a config line, and this feature is not a good enough reason for it.

### The curated numbers agree with the export

This decision would be worthless if hand-curated kilometres and viaduct's recorded
distances disagreed. Measured against the archive, they agree closely and often
exactly: 48 km to Oslo lufthavn on Gardermobanen, 114 to Åndalsnes on Raumabanen, 181
from Alvesta to Malmö on Södra stambanan, 46 from København H to Helsingør, 31 to
Roskilde, 6 from Hamburg Hbf to Altona, 58 from Reading to Paddington, 973 from Nice
to Paris, 227 from Marne-la-Vallée to Lille.

**228 of the 229 trips resolve.** The one that does not is the Hundested–Rorvig
ferry, which has no railway line because it is a boat.

### Where they disagree, the disagreement is published

The registry and the export are two different measurements and will not sum to the
same number. The per-line split is therefore **scaled so it sums to the trip's
recorded `distance_km` exactly**, and the scale factor is stored and returned rather
than swallowed. A split that needed a 1% nudge is fine; one that needed 27% —
Llandudno to Warrington Bank Quay, the single such case — is flagged `scale_suspect`
so it can be argued with.

Scaling is only judged above 20 km. Viaduct rounds to whole kilometres, so its "3 km"
to Jåttåvågen against a real 4.4 is a 30% disagreement about nothing.

**Time is prorated by distance share**, because the trip store holds no intermediate
timings and there is nothing better to prorate by. A trip that crawled over one line
and flew along another will be wrong about both. That is a stated limit, not a bug.

### Ambiguity is a question, not a coin toss

Where two comparable routes exist the tool says so and attributes nothing, until a
human writes an override. Oslo–Trondheim via Dovrebanen or Rørosbanen differs by 4%,
and the registry says so rather than picking.

Detecting this needs care. Banning a whole line and re-routing is not enough:
Rørosbanen is only reachable *through* Dovrebanen, so banning Dovrebanen bans the
Røros route too and the choice would look settled. Banning one **edge** at a time is
what exposes it.

**The escape hatch is not only for ties.** Oslo S–Hønefoss measures 98 km via Roa and
112.5 via Drammen — outside the ambiguity band, so the shortest path picks Roa
outright, and is wrong: viaduct records 112, and the train goes via Drammen. A
confidently wrong answer is worse than an ambiguous one, so overrides pin that too.
Every override carries a `reason` and every response that leans on one says which and
why. A number produced by curation must never look like raw arithmetic.

Two lines that both span the same journey would make every such trip ambiguous for no
reason, so the registry avoids them: Jærbanen is Sørlandsbanen's last 75 km under
another name and is left out, Hovedbanen is left out because Dovre trains take
Gardermobanen, and Frankfurt–Offenbach stops short of Hanau. Rørosbanen and the Roa
route are the deliberate exceptions — they exist *because* the choice is real.

### A crossing is a span on a carrier line

Bridges and tunnels are not lines of their own. Each is a span between two kilometre
posts on a line that carries it, and a leg crosses it when the leg's own span covers
that one end to end. So a London→Bruxelles run counts the Channel Tunnel even though
neither endpoint is within 100 km of a portal.

**Crossings are counted, not measured.** Their rows are marked `crossed` and sit
*outside* the distance partition: the Øresund link's 24 km are already inside
Øresundsbanen's, and counting them twice would break the rule that the parts sum to
the whole.

Counting is per leg and direction-blind, so an out-and-back day trip over the Øresund
bridge is two crossings. Across the archive that gives Ulrikstunnelen 26, Øresund 22,
Storebælt 11, Romeriksporten 7, the Channel Tunnel 6 and the Lötschberg base tunnel 2.

### Curation is code, derivation is data

The registry — lines, kilometre posts, crossings, overrides — is a TypeScript module,
not a table. A line's definition changes by reviewed commit, the way `weather-code.ts`
does. Only `trip_routes` and `trip_line_legs` are stored, and they are pure derivation.

This is the reasoning ADR 0023 used to keep the post↔trip join off both its parent
tables: re-tuning a derivation must never become indistinguishable from ingested fact.
Each row carries the `registry_version` it was computed from, so moving one kilometre
post invalidates every number derived from the old one at once. Nothing is ever half
migrated, and re-resolving the whole archive costs milliseconds because there is no
external call to make.

### Departed, not `Planned`

Totals gate on `departure_at <= now()` rather than on `status`, per ADR 0031 — a trip
is activity once it has left the platform. That excludes next month's trips, includes
the one currently under way, and is robust to a stale export still marked `Planned`.
Trips still to come are returned separately under `upcoming`.

## Consequences

- **The question is one call.** `get_line_stats { line: "Bergensbanen" }` returns
  trips, on-line kilometres and hours, first and last traversal and a per-year
  breakdown; `get_line_trips` reconciles it leg by leg. `list_railway_lines` is the
  registry itself, with travel totals against it.
- A Bergen→Oslo S trip is split across Bergensbanen, Randsfjordbanen, Sørlandsbanen
  and Drammenbanen, and the four sum to the recorded 478 km.
- Öresundsbroa answers with a **crossing count** rather than a distance, and the trips
  behind it.
- Names resolve blind to case, diacritics and which definite article a Scandinavian
  language glued on: `Bergensbanen`, `Bergen Line` and `bergensbana` are one entry, as
  are `Öresundsbron`, `Øresundsbroen` and `Öresundsbroa`. An unknown name returns the
  closest matches, never an empty result.
- **Every response states coverage**, including how many trips could not be resolved
  and why — the same discipline as ADR 0028, and it matters most in the minutes after
  a deploy while the resolver is still catching up. `not_yet_resolved` and `stale` are
  reported separately from `unresolved`, because "nobody has looked yet" and "there is
  no line there" are different answers.
- Coverage is deepest in the Nordics and thins further out. That is a curation
  backlog, not a silence: adding a line is appending to one array, and the next
  resolver tick re-resolves everything.
- The whole attribution is pure and DB-free, so all 30 of its tests run against the
  real registry without Postgres — the same shape as `trip-window.ts` under ADR 0023.
- No new dependency, no new service, no image change. The only new outbound cost is
  nothing at all: this reads data already held.
