import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client.js'

/**
 * viaduct.world's own station positions, from the GPX import. See ADR 0070.
 *
 * Served as stored: one row per waypoint, and two rows for one name is normal (Milano
 * Centrale twice, metres apart). They are viaduct's answer, not the geocoder's; for that
 * comparison, get_station_discrepancies (ADR 0072). Small enough (~750 rows) to send whole,
 * which is what a consumer naming stations on a map needs.
 */

export const getViaductWaypointsSchema = z.object({
  name: z.string().optional()
    .describe('Filter by station name (case-insensitive, partial match)'),
})

export async function getViaductWaypoints(input: z.infer<typeof getViaductWaypointsSchema>) {
  const where = input.name ? sql`WHERE name ILIKE ${`%${input.name}%`}` : sql``
  const rows = (await getDb().execute(sql`
    SELECT name, latitude, longitude, imported_at
    FROM viaduct_waypoints
    ${where}
    ORDER BY name, latitude, longitude`)) as unknown as Array<{
      name: string; latitude: number; longitude: number; imported_at: string | Date
    }>
  const imported = rows.reduce<string | null>((max, r) => {
    const t = new Date(r.imported_at).toISOString()
    return max === null || t > max ? t : max
  }, null)
  return {
    count: rows.length,
    // When the newest of these rows arrived, so a consumer can tell a stale import.
    imported_at: imported,
    waypoints: rows.map((r) => ({ name: r.name, latitude: Number(r.latitude), longitude: Number(r.longitude) })),
  }
}
