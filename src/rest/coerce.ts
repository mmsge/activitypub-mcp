export type CoerceSpec = {
  numbers?: string[]
  booleans?: string[]
  arrays?: string[]
}

/**
 * Turn Hono's raw query map (`c.req.queries()` → Record<string, string[]>) into a
 * typed object that validates against the same Zod schema the MCP tools use.
 *
 * Only keys actually present in the query string are emitted, so the schema's
 * `.default()` / `.optional()` handling applies to omitted params. Number and
 * boolean fields are converted to real JS primitives because the schemas use
 * `z.number()` / `z.boolean()` (not `z.coerce.*`) and therefore require the real
 * type — a non-numeric `limit` becomes `NaN` and is rejected cleanly with a 400.
 * Array fields accept either repeated params (`?t=a&t=b`) or a single
 * comma-separated value (`?t=a,b`). Everything else passes through as a string.
 */
export function coerceQuery(
  queries: Record<string, string[]>,
  spec: CoerceSpec,
): Record<string, unknown> {
  const numbers = new Set(spec.numbers ?? [])
  const booleans = new Set(spec.booleans ?? [])
  const arrays = new Set(spec.arrays ?? [])
  const out: Record<string, unknown> = {}

  for (const [key, values] of Object.entries(queries)) {
    if (!values || values.length === 0) continue
    const first = values[0]

    if (arrays.has(key)) {
      // Repeated params win; otherwise split a single comma-separated value.
      out[key] = values.length > 1
        ? values
        : first.split(',').map((s) => s.trim()).filter(Boolean)
    } else if (numbers.has(key)) {
      out[key] = Number(first)
    } else if (booleans.has(key)) {
      // Leave anything that isn't a clean boolean as the raw string so the
      // schema's z.boolean() surfaces it as a validation error rather than
      // silently coercing (e.g. "false" must not become truthy).
      out[key] = first === 'true' ? true : first === 'false' ? false : first
    } else {
      out[key] = first
    }
  }

  return out
}
