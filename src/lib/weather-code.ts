/**
 * WMO weather codes, as Open-Meteo reports them, in Nynorsk.
 *
 * The archive returns one code per day — the day's dominant condition — so these
 * are deliberately coarse. A day that was drizzly in the morning and clear by
 * afternoon comes back as one number, and pretending otherwise by inventing a
 * richer vocabulary would overstate what the data says.
 *
 * Codes are grouped rather than mapped one-to-one: 51/53/55 are three intensities
 * of drizzle, and "yr" covers all three at the resolution anyone reads this at.
 */

export interface WeatherLabel {
  /** Nynorsk, lower case, for running text: "lett snø". */
  text: string
  /** A single glyph for the stream's trip line. */
  icon: string
}

const LABELS: Array<{ codes: number[]; label: WeatherLabel }> = [
  { codes: [0], label: { text: 'klårvêr', icon: '☀️' } },
  { codes: [1], label: { text: 'stort sett klårt', icon: '🌤️' } },
  { codes: [2], label: { text: 'delvis skya', icon: '⛅' } },
  { codes: [3], label: { text: 'overskya', icon: '☁️' } },
  { codes: [45, 48], label: { text: 'skodde', icon: '🌫️' } },
  { codes: [51, 53, 55], label: { text: 'yr', icon: '🌦️' } },
  { codes: [56, 57], label: { text: 'underkjølt yr', icon: '🌧️' } },
  { codes: [61], label: { text: 'lett regn', icon: '🌦️' } },
  { codes: [63], label: { text: 'regn', icon: '🌧️' } },
  { codes: [65], label: { text: 'kraftig regn', icon: '🌧️' } },
  { codes: [66, 67], label: { text: 'underkjølt regn', icon: '🌧️' } },
  { codes: [71], label: { text: 'lett snø', icon: '🌨️' } },
  { codes: [73], label: { text: 'snø', icon: '🌨️' } },
  { codes: [75], label: { text: 'kraftig snø', icon: '❄️' } },
  { codes: [77], label: { text: 'snøkorn', icon: '🌨️' } },
  { codes: [80, 81, 82], label: { text: 'regnbyer', icon: '🌦️' } },
  { codes: [85, 86], label: { text: 'snøbyer', icon: '🌨️' } },
  { codes: [95], label: { text: 'torevêr', icon: '⛈️' } },
  { codes: [96, 99], label: { text: 'torevêr med hagl', icon: '⛈️' } },
]

const BY_CODE = new Map<number, WeatherLabel>()
for (const { codes, label } of LABELS) for (const c of codes) BY_CODE.set(c, label)

/**
 * The label for a code, or null.
 *
 * Null rather than a guess for anything unmapped: WMO defines codes this table
 * does not cover (4–29 are mostly observer-reported and Open-Meteo does not emit
 * them), and a wrong label on a page is worse than no label.
 */
export function weatherLabel(code: number | null | undefined): WeatherLabel | null {
  if (code == null || !Number.isFinite(code)) return null
  return BY_CODE.get(Math.trunc(code)) ?? null
}

/**
 * A one-line summary for the stream: "🌧️ regn · 12°".
 *
 * Temperature is rounded to a whole degree. Tenths are false precision here —
 * ERA5 is a ~25 km reanalysis, not the thermometer on the platform.
 */
export function weatherSummary(
  code: number | null | undefined,
  tempMaxC: number | null | undefined,
): string | null {
  const label = weatherLabel(code)
  const temp = tempMaxC == null || !Number.isFinite(tempMaxC)
    ? null
    : `${Math.round(tempMaxC)}°`
  if (!label && !temp) return null
  if (!label) return temp
  return temp ? `${label.icon} ${label.text} · ${temp}` : `${label.icon} ${label.text}`
}
