-- The drawn length of each stored GPX route, in km to one decimal. See ADR 0071.
--
-- Segments are summed, and the gaps between them are not bridged: viaduct does not put
-- segments in travel order, so a gap is not a known distance. Reported beside
-- `train_trips.distance_km` and never substituted for it.
--
-- The backfill mirrors `trackLengthKm` in src/lib/geo-distance.ts: haversine, radius
-- 6371 km, each consecutive pair within a segment, rounded once at the end. Rows stored
-- after this migration get the value from the importer.
ALTER TABLE "trip_tracks" ADD COLUMN "measured_km" double precision;
--> statement-breakpoint
WITH pts AS (
	SELECT tt.id, s.ord AS seg, p.ord AS i,
		(p.pt->>1)::float8 AS lat, (p.pt->>0)::float8 AS lon
	FROM trip_tracks tt,
		jsonb_array_elements(tt.segments) WITH ORDINALITY AS s(seg, ord),
		jsonb_array_elements(s.seg) WITH ORDINALITY AS p(pt, ord)
), pairs AS (
	SELECT id, lat, lon,
		lag(lat) OVER w AS plat, lag(lon) OVER w AS plon
	FROM pts
	WINDOW w AS (PARTITION BY id, seg ORDER BY i)
), lengths AS (
	SELECT id, sum(2 * 6371 * asin(least(1, sqrt(
		power(sin(radians(lat - plat) / 2), 2)
		+ cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lon - plon) / 2), 2)
	)))) AS km
	FROM pairs
	WHERE plat IS NOT NULL
	GROUP BY id
)
UPDATE trip_tracks t SET measured_km = round(l.km::numeric, 1)::float8
FROM lengths l
WHERE l.id = t.id;
