/**
 * The named railway lines and fixed links, curated by hand.
 *
 * A line here is an ordered list of stations with a kilometre position along it —
 * the railway's own *kilometrering*, not a geometry. Everything the line tools
 * report is arithmetic over these numbers, which means every kilometre in an answer
 * traces back to a row a human wrote and can correct.
 *
 * ## Why not OpenStreetMap geometry
 *
 * The obvious alternative is PostGIS plus an OSM rail graph: route each station pair
 * over real track and intersect the result with each line's geometry. It was not
 * done, for three reasons.
 *
 * The routing would only be as good as the station coordinates, and those are
 * demonstrably bad: the geocoder behind `get_trip_weather` currently matches "Oslo S"
 * to *Rue d'Oslo, Strasbourg* and "Malmö C" to *Allée de Malmoë, Rennes* (ADR 0028
 * kept `display_name` precisely so that would be visible). Second, the archive is
 * ~230 trips over ~115 stations — a scale where hand-curation is a day's work and
 * gives an exactly auditable answer. Third, PostGIS would mean changing the database
 * image on a shared production host for a feature that does not need it.
 *
 * The measurements below were checked against the distances viaduct.world already
 * records. Many agree exactly — Gardermobanen's 48 km to Oslo lufthavn, Raumabanen's
 * 114 to Åndalsnes, 181 from Alvesta to Malmö, 46 from København H to Helsingør, 31
 * to Roskilde, 58 from Reading to Paddington, 973 from Nice to Paris. Where they
 * disagree the difference is absorbed by scaling (see `line-attribution.ts`) and the
 * scale factor is stored, so the disagreement is reported rather than hidden.
 *
 * ## Rules this file follows
 *
 * - **Station names are verbatim** as they appear in `train_trips.from_station` /
 *   `to_station`. A name that does not match exactly simply never matches. Junction
 *   stations Markus has never stopped at are included too — they are the graph nodes
 *   that let a Bergen→Oslo run be split at Hønefoss.
 *
 * - **Two lines must not both span the same journey**, or every such trip resolves as
 *   ambiguous and needs an override to say something obvious. So Jærbanen is left out
 *   (it is Sørlandsbanen's last 75 km under another name) and Hovedbanen is left out
 *   (Dovre trains take Gardermobanen). The exceptions are deliberate: Rørosbanen and
 *   the Roa route exist here *because* the choice between them is genuinely open, and
 *   an override is the honest way to close it.
 *
 * - **A crossing is a span on a carrier line**, not a line of its own. That way the
 *   Channel Tunnel is counted on a London→Bruxelles run whose endpoints are hundreds
 *   of kilometres from either portal.
 *
 * Coverage is deliberately deepest in the Nordics and thinner further out. A leg that
 * no line explains is reported as unresolved, never as zero.
 *
 * See ADR 0035.
 */

/** One station's position along a line, measured from the line's zero point. */
export interface KmPost {
  /** Verbatim as in `train_trips`; junction anchors may be names Markus never used. */
  station: string
  km: number
}

export interface RailwayLine {
  slug: string
  /** The name to answer with. Norwegian lines keep their official definite form. */
  name: string
  /** Everything else that should resolve to this entry; matched diacritic-blind. */
  aliases: string[]
  /** ISO 3166-1 alpha-2, in the order the line runs through them. */
  countries: string[]
  /** Ascending by km. The gaps between consecutive posts are the graph's edges. */
  points: KmPost[]
  notes?: string
}

export interface Crossing {
  slug: string
  name: string
  aliases: string[]
  countries: string[]
  /** Slug of the line whose kilometres `fromKm`/`toKm` are measured in. */
  carrier: string
  fromKm: number
  toKm: number
  notes?: string
}

/**
 * A pinned routing. The escape hatch for the cases the shortest path gets wrong —
 * and it gets Oslo→Hønefoss confidently wrong, which is worse than getting it
 * ambiguously wrong. `reason` is surfaced in every response that leans on the entry,
 * so a number produced this way says so.
 */
export interface RouteOverride {
  from: string
  to: string
  /** Ordered line slugs; consecutive lines must share a station to split at. */
  lines: string[]
  reason: string
  /** Applies in both directions unless set false. */
  bothWays?: boolean
}

// ---------------------------------------------------------------------------
// Norway
// ---------------------------------------------------------------------------

const NORWAY: RailwayLine[] = [
  {
    slug: 'bergensbanen',
    name: 'Bergensbanen',
    aliases: ['Bergensbana', 'Bergen Line', 'Bergensbanan', 'Oslo–Bergen'],
    countries: ['NO'],
    notes: 'Bergen–Hønefoss. The Oslo continuation is a different line, whichever way it goes.',
    points: [
      { station: 'Bergen', km: 0 },
      { station: 'Arna', km: 9.6 },
      { station: 'Dale', km: 66.6 },
      { station: 'Voss', km: 106.7 },
      { station: 'Myrdal', km: 158.6 },
      { station: 'Finse', km: 187.7 },
      { station: 'Haugastøl', km: 205.2 },
      { station: 'Ustaoset', km: 218.3 },
      { station: 'Geilo', km: 224.5 },
      { station: 'Ål', km: 250.6 },
      { station: 'Gol', km: 269.4 },
      { station: 'Nesbyen', km: 285.8 },
      { station: 'Flå', km: 313.9 },
      { station: 'Hønefoss', km: 371.4 },
    ],
  },
  {
    slug: 'randsfjordbanen',
    name: 'Randsfjordbanen',
    aliases: ['Randsfjordbana', 'Hokksund–Hønefoss'],
    countries: ['NO'],
    points: [
      { station: 'Hokksund', km: 0 },
      { station: 'Vikersund', km: 25.6 },
      { station: 'Hønefoss', km: 52.4 },
    ],
  },
  {
    slug: 'drammenbanen',
    name: 'Drammenbanen',
    aliases: ['Drammenbana', 'Oslo–Drammen'],
    countries: ['NO'],
    points: [
      { station: 'Oslo S', km: 0 },
      { station: 'Skøyen', km: 4.4 },
      { station: 'Lysaker', km: 7.6 },
      { station: 'Sandvika', km: 15.4 },
      { station: 'Asker', km: 23.9 },
      { station: 'Drammen', km: 42.7 },
    ],
  },
  {
    slug: 'sorlandsbanen',
    name: 'Sørlandsbanen',
    aliases: ['Sørlandsbana', 'Sorlandsbanen', 'Southern Line', 'Drammen–Stavanger'],
    countries: ['NO'],
    notes: 'Jærbanen is the Stavanger–Egersund end of this line and is not listed separately.',
    points: [
      { station: 'Drammen', km: 0 },
      { station: 'Hokksund', km: 17.4 },
      { station: 'Kongsberg', km: 43.4 },
      { station: 'Nordagutu', km: 91.2 },
      { station: 'Bø', km: 105.2 },
      { station: 'Neslandsvatn', km: 164.9 },
      { station: 'Nelaug', km: 213.6 },
      { station: 'Kristiansand', km: 320.0 },
      { station: 'Egersund', km: 459.8 },
      { station: 'Sandnes', km: 528.2 },
      { station: 'Jåttåvågen', km: 540.6 },
      { station: 'Stavanger', km: 545.0 },
    ],
  },
  {
    slug: 'ostfoldbanen',
    name: 'Østfoldbanen',
    aliases: ['Østfoldbana', 'Ostfoldbanen', 'Oslo–Kornsjø'],
    countries: ['NO'],
    points: [
      { station: 'Oslo S', km: 0 },
      { station: 'Ski', km: 24.1 },
      { station: 'Moss', km: 60.4 },
      { station: 'Fredrikstad', km: 94.7 },
      { station: 'Sarpsborg', km: 110.7 },
      { station: 'Halden', km: 136.3 },
      { station: 'Kornsjø', km: 170.1 },
    ],
  },
  {
    slug: 'gardermobanen',
    name: 'Gardermobanen',
    aliases: ['Gardermobana', 'Oslo Airport Line', 'Flytogbanen'],
    countries: ['NO'],
    points: [
      { station: 'Oslo S', km: 0 },
      { station: 'Lillestrøm', km: 21.0 },
      { station: 'Oslo lufthavn', km: 48.0 },
      { station: 'Eidsvoll', km: 64.0 },
    ],
  },
  {
    slug: 'dovrebanen',
    name: 'Dovrebanen',
    aliases: ['Dovrebana', 'Dovre Line', 'Eidsvoll–Trondheim'],
    countries: ['NO'],
    points: [
      { station: 'Eidsvoll', km: 0 },
      { station: 'Hamar', km: 58.0 },
      { station: 'Lillehammer', km: 116.0 },
      { station: 'Otta', km: 216.0 },
      { station: 'Dombås', km: 275.0 },
      { station: 'Oppdal', km: 342.0 },
      { station: 'Støren', km: 419.0 },
      { station: 'Trondheim', km: 485.0 },
    ],
  },
  {
    slug: 'rorosbanen',
    name: 'Rørosbanen',
    aliases: ['Rørosbana', 'Rorosbanen', 'Røros Line', 'Hamar–Støren'],
    countries: ['NO'],
    notes: 'Kept even though Markus has not ridden it: it is the reason Oslo–Trondheim is an open question.',
    points: [
      { station: 'Hamar', km: 0 },
      { station: 'Elverum', km: 31.0 },
      { station: 'Koppang', km: 111.0 },
      { station: 'Tynset', km: 187.0 },
      { station: 'Røros', km: 246.0 },
      { station: 'Støren', km: 382.0 },
    ],
  },
  {
    slug: 'raumabanen',
    name: 'Raumabanen',
    aliases: ['Raumabana', 'Rauma Line', 'Dombås–Åndalsnes'],
    countries: ['NO'],
    points: [
      { station: 'Dombås', km: 0 },
      { station: 'Bjorli', km: 47.0 },
      { station: 'Verma', km: 78.0 },
      { station: 'Åndalsnes', km: 114.2 },
    ],
  },
  {
    slug: 'gjovikbanen',
    name: 'Gjøvikbanen',
    aliases: ['Gjøvikbana', 'Gjovikbanen', 'Oslo–Gjøvik'],
    countries: ['NO'],
    points: [
      { station: 'Oslo S', km: 0 },
      { station: 'Grefsen', km: 5.0 },
      { station: 'Roa', km: 66.0 },
      { station: 'Jaren', km: 82.0 },
      { station: 'Gjøvik', km: 123.7 },
    ],
  },
  {
    slug: 'roa-honefossbanen',
    name: 'Roa–Hønefossbanen',
    aliases: ['Roa-Hønefossbanen', 'Roa–Hønefossbana', 'Roa–Hønefoss'],
    countries: ['NO'],
    points: [
      { station: 'Roa', km: 0 },
      { station: 'Jevnaker', km: 15.0 },
      { station: 'Hønefoss', km: 32.0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Sweden
// ---------------------------------------------------------------------------

const SWEDEN: RailwayLine[] = [
  {
    slug: 'norge-vanerbanan',
    name: 'Norge/Vänerbanan',
    aliases: ['Norge-Vänerbanan', 'Norge/Vanerbanan', 'Göteborg–Kornsjø', 'Vänerbanan'],
    countries: ['SE', 'NO'],
    points: [
      { station: 'Göteborgs central', km: 0 },
      { station: 'Trollhättan', km: 71.0 },
      { station: 'Öxnered', km: 79.0 },
      { station: 'Ed', km: 145.0 },
      { station: 'Kornsjø', km: 178.0 },
    ],
  },
  {
    slug: 'vastkustbanan',
    name: 'Västkustbanan',
    aliases: ['Vastkustbanan', 'Vestkystbanen', 'West Coast Line', 'Göteborg–Lund'],
    countries: ['SE'],
    notes: 'Ends at Lund; the last stretch into Malmö is Södra stambanan.',
    points: [
      { station: 'Göteborgs central', km: 0 },
      { station: 'Mölndal', km: 8.0 },
      { station: 'Hede', km: 21.0 },
      { station: 'Kungsbacka', km: 30.0 },
      { station: 'Varberg', km: 76.0 },
      { station: 'Falkenberg', km: 105.0 },
      { station: 'Halmstad C', km: 145.0 },
      { station: 'Ängelholm', km: 210.0 },
      { station: 'Helsingborg C', km: 232.0 },
      { station: 'Landskrona', km: 258.0 },
      { station: 'Lund C', km: 285.0 },
    ],
  },
  {
    slug: 'sodra-stambanan',
    name: 'Södra stambanan',
    aliases: ['Sodra stambanan', 'Søre stambane', 'Southern Main Line', 'Malmö–Stockholm'],
    countries: ['SE'],
    points: [
      { station: 'Malmö C', km: 0 },
      { station: 'Lund C', km: 16.0 },
      { station: 'Hässleholm', km: 78.0 },
      { station: 'Alvesta', km: 181.0 },
      { station: 'Nässjö', km: 258.0 },
      { station: 'Mjölby', km: 372.0 },
      { station: 'Linköping', km: 400.0 },
      { station: 'Norrköping', km: 435.0 },
      { station: 'Katrineholm', km: 501.0 },
      { station: 'Södertälje syd', km: 578.0 },
      { station: 'Stockholm C', km: 614.0 },
    ],
  },
  {
    slug: 'oresundsbanan',
    name: 'Øresundsbanen',
    aliases: ['Öresundsbanan', 'Oresundsbanan', 'Øresundsbanen', 'København–Malmö'],
    countries: ['DK', 'SE'],
    points: [
      { station: 'Københavns Hovedbanegård', km: 0 },
      { station: 'Ørestad', km: 8.8 },
      { station: 'Københavns Lufthavn Kastrup', km: 12.8 },
      { station: 'Peberholm', km: 20.8 },
      { station: 'Hyllie', km: 36.8 },
      { station: 'Triangeln', km: 39.8 },
      { station: 'Malmö C', km: 42.8 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Denmark
// ---------------------------------------------------------------------------

const DENMARK: RailwayLine[] = [
  {
    slug: 'kystbanen',
    name: 'Kystbanen',
    aliases: ['Kystbana', 'Coast Line', 'København–Helsingør'],
    countries: ['DK'],
    points: [
      { station: 'Vesterport', km: 0 },
      { station: 'Københavns Hovedbanegård', km: 1.2 },
      { station: 'Nørreport', km: 2.4 },
      { station: 'Østerport', km: 4.0 },
      { station: 'Hellerup', km: 7.8 },
      { station: 'Klampenborg', km: 12.8 },
      { station: 'Rungsted Kyst', km: 24.8 },
      { station: 'Snekkersten', km: 43.2 },
      { station: 'Helsingør', km: 47.2 },
    ],
  },
  {
    slug: 'vestbanen',
    name: 'Vestbanen',
    aliases: ['Vestbana', 'København–Nyborg', 'Den sjællandske vestbane'],
    countries: ['DK'],
    notes: 'Runs on through the Great Belt link to Nyborg, so the crossing has a carrier.',
    points: [
      { station: 'Københavns Hovedbanegård', km: 0 },
      { station: 'Valby', km: 4.0 },
      { station: 'Høje Taastrup', km: 19.0 },
      { station: 'Roskilde', km: 31.0 },
      { station: 'Ringsted', km: 62.0 },
      { station: 'Sorø', km: 78.0 },
      { station: 'Slagelse', km: 100.0 },
      { station: 'Korsør', km: 110.0 },
      { station: 'Nyborg', km: 128.0 },
    ],
  },
  {
    slug: 'fynske-hovedbane',
    name: 'Den fynske hovedbane',
    aliases: ['Fynske hovedbane', 'Nyborg–Fredericia', 'Fyn'],
    countries: ['DK'],
    points: [
      { station: 'Nyborg', km: 0 },
      { station: 'Odense', km: 30.0 },
      { station: 'Middelfart', km: 63.0 },
      { station: 'Fredericia', km: 77.0 },
    ],
  },
  {
    slug: 'sonderjyske-langdebane',
    name: 'Den sønderjyske længdebane',
    aliases: ['Sønderjyske længdebane', 'Fredericia–Padborg'],
    countries: ['DK'],
    points: [
      { station: 'Fredericia', km: 0 },
      { station: 'Kolding', km: 26.0 },
      { station: 'Vojens', km: 66.0 },
      { station: 'Rødekro', km: 90.0 },
      { station: 'Padborg', km: 116.0 },
    ],
  },
  {
    slug: 'sydbanen',
    name: 'Sydbanen',
    aliases: ['Sydbana', 'Ringsted–Rødby'],
    countries: ['DK'],
    points: [
      { station: 'Ringsted', km: 0 },
      { station: 'Næstved', km: 27.0 },
      { station: 'Vordingborg', km: 55.0 },
      { station: 'Nykøbing F', km: 87.0 },
      { station: 'Rødby Færge', km: 111.0 },
    ],
  },
  {
    slug: 'nordvestbanen',
    name: 'Nordvestbanen',
    aliases: ['Nordvestbana', 'Roskilde–Kalundborg'],
    countries: ['DK'],
    points: [
      { station: 'Roskilde', km: 0 },
      { station: 'Holbæk', km: 36.0 },
      { station: 'Kalundborg', km: 76.0 },
    ],
  },
  {
    slug: 'odsherredsbanen',
    name: 'Odsherredsbanen',
    aliases: ['Odsherredsbana', 'Holbæk–Nykøbing Sj'],
    countries: ['DK'],
    points: [
      { station: 'Holbæk', km: 0 },
      { station: 'Svinninge', km: 18.0 },
      { station: 'Nykøbing Sj', km: 49.5 },
    ],
  },
  {
    slug: 'hornbaekbanen',
    name: 'Hornbækbanen',
    aliases: ['Hornbaekbanen', 'Hornbækbana', 'Helsingør–Gilleleje'],
    countries: ['DK'],
    points: [
      { station: 'Helsingør', km: 0 },
      { station: 'Hornbæk', km: 14.0 },
      { station: 'Gilleleje', km: 24.5 },
    ],
  },
  {
    slug: 'gribskovbanen',
    name: 'Gribskovbanen',
    aliases: ['Gribskovbana', 'Gilleleje–Hillerød'],
    countries: ['DK'],
    points: [
      { station: 'Gilleleje', km: 0 },
      { station: 'Græsted', km: 8.0 },
      { station: 'Hillerød', km: 25.0 },
    ],
  },
  {
    slug: 'frederiksvaerkbanen',
    name: 'Frederiksværkbanen',
    aliases: ['Frederiksvaerkbanen', 'Frederiksværkbana', 'Hillerød–Hundested'],
    countries: ['DK'],
    points: [
      { station: 'Hillerød', km: 0 },
      { station: 'Frederiksværk', km: 30.0 },
      { station: 'Hundested', km: 39.0 },
      { station: 'Hundested Havn', km: 41.0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Germany, the Low Countries and the Alps
// ---------------------------------------------------------------------------

const CENTRAL_EUROPE: RailwayLine[] = [
  {
    slug: 'jutlandbanen-de',
    name: 'Hamburg–Padborg',
    aliases: ['Jyllandsruta', 'Hamburg–Flensburg', 'Vogelfluglinie landvegen'],
    countries: ['DE', 'DK'],
    points: [
      { station: 'Hamburg Hbf', km: 0 },
      { station: 'Neumünster', km: 59.0 },
      { station: 'Rendsburg', km: 89.0 },
      { station: 'Flensburg', km: 154.0 },
      { station: 'Padborg', km: 164.0 },
    ],
  },
  {
    slug: 'hamburg-berliner-bahn',
    name: 'Hamburg–Berliner Bahn',
    aliases: ['Berlin–Hamburg', 'Hamburg–Berlin'],
    countries: ['DE'],
    points: [
      { station: 'Hamburg Hbf', km: 0 },
      { station: 'Büchen', km: 45.0 },
      { station: 'Ludwigslust', km: 128.0 },
      { station: 'Wittenberge', km: 174.0 },
      { station: 'Berlin Spandau', km: 274.0 },
      { station: 'Berlin Hbf', km: 286.0 },
    ],
  },
  {
    slug: 'berliner-stadtbahn',
    name: 'Berliner Stadtbahn',
    aliases: ['Stadtbahn', 'Berlin Stadtbahn'],
    countries: ['DE'],
    points: [
      { station: 'Warschauer Straße', km: 0 },
      { station: 'Berlin Ostbahnhof', km: 1.4 },
      { station: 'Berlin Alexanderplatz', km: 4.2 },
      { station: 'Friedrichstraße', km: 5.6 },
      { station: 'Berlin Hbf', km: 7.4 },
    ],
  },
  {
    slug: 'rollbahn',
    name: 'Rollbahn',
    aliases: ['Wanne-Eickel–Hamburg', 'Hamburg–Köln', 'Hamburg–Bremen–Osnabrück'],
    countries: ['DE'],
    points: [
      { station: 'Hamburg-Altona', km: 0 },
      { station: 'Hamburg Hbf', km: 6.0 },
      { station: 'Bremen Hbf', km: 121.0 },
      { station: 'Osnabrück Hbf', km: 244.0 },
      { station: 'Münster Hbf', km: 306.0 },
      { station: 'Dortmund Hbf', km: 375.0 },
      { station: 'Köln Hbf', km: 455.0 },
    ],
  },
  {
    slug: 'hollandstrecke',
    name: 'Hollandstrecke',
    aliases: ['Amsterdam–Osnabrück', 'Amsterdam–Bad Bentheim'],
    countries: ['NL', 'DE'],
    points: [
      { station: 'Amsterdam Centraal', km: 0 },
      { station: 'Amersfoort', km: 45.0 },
      { station: 'Hengelo', km: 155.0 },
      { station: 'Bad Bentheim', km: 175.0 },
      { station: 'Rheine', km: 190.0 },
      { station: 'Osnabrück Hbf', km: 245.0 },
    ],
  },
  {
    slug: 'koln-brussel',
    name: 'Køln–Brussel',
    aliases: ['Köln–Brüssel', 'Köln–Bruxelles', 'Koln-Brussel', 'HSL 3'],
    countries: ['DE', 'BE'],
    points: [
      { station: 'Köln Hbf', km: 0 },
      { station: 'Aachen Hbf', km: 70.0 },
      { station: 'Liège-Guillemins', km: 115.0 },
      { station: 'Leuven', km: 190.0 },
      { station: 'Bruxelles-Midi - Brussel-Zuid', km: 220.0 },
    ],
  },
  {
    slug: 'hsl-zuid',
    name: 'HSL-Zuid',
    aliases: ['Brussel–Amsterdam', 'Bruxelles–Amsterdam', 'HSL Zuid'],
    countries: ['BE', 'NL'],
    points: [
      { station: 'Bruxelles-Midi - Brussel-Zuid', km: 0 },
      { station: 'Antwerpen-Centraal', km: 45.0 },
      { station: 'Rotterdam Centraal', km: 125.0 },
      { station: 'Schiphol', km: 180.0 },
      { station: 'Amsterdam Centraal', km: 195.0 },
    ],
  },
  {
    slug: 'hannover-hamburger-bahn',
    name: 'Hannover–Hamburger Bahn',
    aliases: ['Hamburg–Hannover', 'Hannover–Hamburg'],
    countries: ['DE'],
    points: [
      { station: 'Hamburg Hbf', km: 0 },
      { station: 'Lüneburg', km: 55.0 },
      { station: 'Uelzen', km: 95.0 },
      { station: 'Celle', km: 145.0 },
      { station: 'Hannover Hbf', km: 178.0 },
    ],
  },
  {
    slug: 'sfs-hannover-wurzburg',
    name: 'Schnellfahrstrecke Hannover–Würzburg',
    aliases: ['SFS Hannover–Würzburg', 'Hannover–Würzburg', 'Hannover-Wurzburg'],
    countries: ['DE'],
    points: [
      { station: 'Hannover Hbf', km: 0 },
      { station: 'Göttingen', km: 100.0 },
      { station: 'Kassel-Wilhelmshöhe', km: 145.0 },
      { station: 'Fulda', km: 248.0 },
      { station: 'Würzburg Hbf', km: 327.0 },
    ],
  },
  {
    slug: 'kinzigtalbahn',
    name: 'Kinzigtalbahn',
    aliases: ['Fulda–Frankfurt', 'Kinzigtal'],
    countries: ['DE'],
    points: [
      { station: 'Fulda', km: 0 },
      { station: 'Hanau Hbf', km: 87.0 },
      { station: 'Frankfurt (Main) Hbf', km: 100.0 },
    ],
  },
  {
    slug: 'riedbahn',
    name: 'Riedbahn',
    aliases: ['Frankfurt–Mannheim'],
    countries: ['DE'],
    points: [
      { station: 'Frankfurt (Main) Hbf', km: 0 },
      { station: 'Frankfurt (Main) Süd', km: 4.0 },
      { station: 'Groß-Gerau', km: 25.0 },
      { station: 'Biblis', km: 50.0 },
      { station: 'Mannheim Hbf', km: 81.0 },
    ],
  },
  {
    slug: 'main-neckar-bahn',
    name: 'Main-Neckar-Bahn',
    aliases: ['Main Neckar Bahn', 'Frankfurt–Heidelberg'],
    countries: ['DE'],
    points: [
      { station: 'Frankfurt (Main) Hbf', km: 0 },
      { station: 'Frankfurt (Main) Süd', km: 4.0 },
      { station: 'Darmstadt Hbf', km: 30.0 },
      { station: 'Bensheim', km: 55.0 },
      { station: 'Weinheim', km: 70.0 },
      { station: 'Heidelberg Hbf', km: 88.0 },
    ],
  },
  {
    slug: 'badische-hauptbahn',
    name: 'Badische Hauptbahn',
    aliases: ['Rheintalbahn', 'Mannheim–Basel', 'Baden Hauptbahn'],
    countries: ['DE', 'CH'],
    points: [
      { station: 'Mannheim Hbf', km: 0 },
      { station: 'Heidelberg Hbf', km: 18.0 },
      { station: 'Karlsruhe Hbf', km: 62.0 },
      { station: 'Offenburg', km: 128.0 },
      { station: 'Freiburg (Breisgau) Hbf', km: 196.0 },
      { station: 'Basel SBB', km: 260.0 },
    ],
  },
  {
    slug: 'mainbahn',
    name: 'Mainbahn',
    aliases: ['Frankfurt–Mainz'],
    countries: ['DE'],
    points: [
      { station: 'Frankfurt (Main) Hbf', km: 0 },
      { station: 'Rüsselsheim', km: 22.0 },
      { station: 'Mainz Hbf', km: 38.0 },
    ],
  },
  {
    slug: 'mainz-mannheim',
    name: 'Mainz–Mannheim',
    aliases: ['Rheinstrecke Mainz–Mannheim', 'Mainz-Mannheim'],
    countries: ['DE'],
    points: [
      { station: 'Mainz Hbf', km: 0 },
      { station: 'Worms', km: 45.0 },
      { station: 'Mannheim Hbf', km: 71.0 },
    ],
  },
  {
    slug: 'frankfurt-offenbach',
    name: 'Frankfurt–Offenbach',
    aliases: ['Offenbach', 'Frankfurt-Offenbach', 'Offenbacher S-Bahn'],
    countries: ['DE'],
    notes: 'Stops at Offenbach rather than running on to Hanau: continuing would give Fulda→Frankfurt a second, longer path through Offenbach and make an obvious routing look like an open question.',
    points: [
      { station: 'Frankfurt (Main) Süd', km: 0 },
      { station: 'Offenbach (Main) Hbf', km: 6.0 },
    ],
  },
  {
    slug: 'elbe-dresden-praha',
    name: 'Berlin–Dresden–Praha',
    aliases: ['Elbedalbanen', 'Dresden–Prag', 'Berlin–Prag'],
    countries: ['DE', 'CZ'],
    points: [
      { station: 'Berlin Hbf', km: 0 },
      { station: 'Dresden Hbf', km: 190.0 },
      { station: 'Bad Schandau', km: 230.0 },
      { station: 'Ústí nad Labem', km: 260.0 },
      { station: 'Praha hl.n.', km: 350.0 },
    ],
  },
  {
    slug: 'praha-wien',
    name: 'Praha–Wien',
    aliases: ['Prag–Wien', 'Praha-Wien', 'Brno-korridoren'],
    countries: ['CZ', 'AT'],
    points: [
      { station: 'Praha hl.n.', km: 0 },
      { station: 'Pardubice', km: 105.0 },
      { station: 'Brno hl.n.', km: 255.0 },
      { station: 'Břeclav', km: 315.0 },
      { station: 'Wien Hbf', km: 404.0 },
    ],
  },
  {
    slug: 'warszawa-praha',
    name: 'Warszawa–Praha',
    aliases: ['Warszawa-Praha', 'Warsaw–Prague'],
    countries: ['PL', 'CZ'],
    points: [
      { station: 'Warszawa Centralna', km: 0 },
      { station: 'Katowice', km: 300.0 },
      { station: 'Bohumín', km: 370.0 },
      { station: 'Ostrava', km: 385.0 },
      { station: 'Přerov', km: 470.0 },
      { station: 'Pardubice', km: 580.0 },
      { station: 'Praha hl.n.', km: 684.0 },
    ],
  },
  {
    slug: 'sudbahn-at',
    name: 'Südbahn',
    aliases: ['Sudbahn', 'Wien–Villach', 'Austrian Southern Railway'],
    countries: ['AT'],
    points: [
      { station: 'Wien Hbf', km: 0 },
      { station: 'Wiener Neustadt', km: 40.0 },
      { station: 'Bruck an der Mur', km: 160.0 },
      { station: 'Klagenfurt', km: 320.0 },
      { station: 'Villach Hbf', km: 360.0 },
    ],
  },
  {
    slug: 'wien-zagreb',
    name: 'Wien–Zagreb',
    aliases: ['Wien-Zagreb', 'Graz–Zagreb'],
    countries: ['AT', 'SI', 'HR'],
    points: [
      { station: 'Wien Hbf', km: 0 },
      { station: 'Graz Hbf', km: 200.0 },
      { station: 'Spielfeld-Straß', km: 250.0 },
      { station: 'Maribor', km: 265.0 },
      { station: 'Zidani Most', km: 350.0 },
      { station: 'Zagreb Glavni kol.', km: 446.0 },
    ],
  },
  {
    slug: 'zagreb-villach',
    name: 'Zagreb–Ljubljana–Villach',
    aliases: ['Zagreb-Villach', 'Ljubljana–Villach'],
    countries: ['HR', 'SI', 'AT'],
    points: [
      { station: 'Zagreb Glavni kol.', km: 0 },
      { station: 'Zidani Most', km: 90.0 },
      { station: 'Ljubljana', km: 140.0 },
      { station: 'Jesenice', km: 205.0 },
      { station: 'Villach Hbf', km: 243.0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Switzerland — mostly narrow gauge, mostly uphill
// ---------------------------------------------------------------------------

const SWITZERLAND: RailwayLine[] = [
  {
    slug: 'basel-zurich',
    name: 'Basel–Zürich',
    aliases: ['Bözbergbanen', 'Basel-Zurich'],
    countries: ['CH'],
    points: [
      { station: 'Basel SBB', km: 0 },
      { station: 'Brugg', km: 70.0 },
      { station: 'Baden', km: 85.0 },
      { station: 'Zürich HB', km: 91.0 },
    ],
  },
  {
    slug: 'zurich-bern',
    name: 'Zürich–Bern',
    aliases: ['Zurich-Bern', 'Olten-korridoren'],
    countries: ['CH'],
    points: [
      { station: 'Zürich HB', km: 0 },
      { station: 'Olten', km: 60.0 },
      { station: 'Bern', km: 125.0 },
    ],
  },
  {
    slug: 'lotschbergbahn',
    name: 'Lötschbergbanen',
    aliases: ['Lötschbergbahn', 'Lotschbergbahn', 'Lötschberg', 'Bern–Brig'],
    countries: ['CH'],
    notes: 'The base-tunnel alignment via Frutigen and Raron, which is what the trains take.',
    points: [
      { station: 'Bern', km: 0 },
      { station: 'Thun', km: 31.0 },
      { station: 'Spiez', km: 41.0 },
      { station: 'Frutigen', km: 55.0 },
      { station: 'Raron', km: 90.0 },
      { station: 'Visp', km: 96.0 },
      { station: 'Brig', km: 105.0 },
    ],
  },
  {
    slug: 'thunerseebahn',
    name: 'Thunerseebahn',
    aliases: ['Spiez–Interlaken', 'Thunersee'],
    countries: ['CH'],
    points: [
      { station: 'Spiez', km: 0 },
      { station: 'Interlaken West', km: 16.0 },
      { station: 'Interlaken Ost', km: 18.0 },
    ],
  },
  {
    slug: 'brunigbanen',
    name: 'Brünigbanen',
    aliases: ['Brünigbahn', 'Brunigbahn', 'Interlaken–Luzern', 'Zentralbahn'],
    countries: ['CH'],
    points: [
      { station: 'Interlaken Ost', km: 0 },
      { station: 'Brienz', km: 16.0 },
      { station: 'Meiringen', km: 30.0 },
      { station: 'Giswil', km: 55.0 },
      { station: 'Luzern', km: 73.0 },
    ],
  },
  {
    slug: 'brienz-rothorn-banen',
    name: 'Brienz-Rothorn-banen',
    aliases: ['Brienz-Rothorn-Bahn', 'Brienzer Rothorn Bahn', 'Rothornbanen'],
    countries: ['CH'],
    points: [
      { station: 'Brienz', km: 0 },
      { station: 'Planalp', km: 4.5 },
      { station: 'Brienzer Rothorn', km: 7.6 },
    ],
  },
  {
    slug: 'berner-oberland-banen',
    name: 'Berner Oberland-banen',
    aliases: ['Berner-Oberland-Bahnen', 'BOB', 'Interlaken–Lauterbrunnen'],
    countries: ['CH'],
    points: [
      { station: 'Interlaken Ost', km: 0 },
      { station: 'Zweilütschinen', km: 7.0 },
      { station: 'Lauterbrunnen', km: 12.3 },
    ],
  },
  {
    slug: 'wengernalpbanen',
    name: 'Wengernalpbanen',
    aliases: ['Wengernalpbahn', 'WAB', 'Lauterbrunnen–Kleine Scheidegg'],
    countries: ['CH'],
    points: [
      { station: 'Lauterbrunnen', km: 0 },
      { station: 'Wengen', km: 6.0 },
      { station: 'Kleine Scheidegg', km: 10.3 },
    ],
  },
  {
    slug: 'jungfraubanen',
    name: 'Jungfraubanen',
    aliases: ['Jungfraubahn', 'Jungfraubahnen', 'Kleine Scheidegg–Jungfraujoch'],
    countries: ['CH'],
    points: [
      { station: 'Kleine Scheidegg', km: 0 },
      { station: 'Eigergletscher', km: 2.0 },
      { station: 'Jungfraujoch', km: 9.3 },
    ],
  },
  {
    slug: 'matterhorn-gotthard-banen',
    name: 'Matterhorn-Gotthard-banen',
    aliases: ['Matterhorn-Gotthard-Bahn', 'MGB', 'Visp–Zermatt'],
    countries: ['CH'],
    points: [
      { station: 'Visp', km: 0 },
      { station: 'Stalden-Saas', km: 12.0 },
      { station: 'St. Niklaus', km: 22.0 },
      { station: 'Täsch', km: 30.0 },
      { station: 'Zermatt', km: 35.0 },
    ],
  },
  {
    slug: 'gornergratbanen',
    name: 'Gornergratbanen',
    aliases: ['Gornergratbahn', 'Gornergrat Bahn'],
    countries: ['CH'],
    points: [
      { station: 'Zermatt', km: 0 },
      { station: 'Riffelberg', km: 5.5 },
      { station: 'Gornergrat', km: 9.3 },
    ],
  },
  {
    slug: 'albulabanen',
    name: 'Albulabanen',
    aliases: ['Albulabahn', 'Albula', 'Chur–St. Moritz'],
    countries: ['CH'],
    points: [
      { station: 'Chur', km: 0 },
      { station: 'Thusis', km: 32.0 },
      { station: 'Filisur', km: 55.0 },
      { station: 'Bergün', km: 62.0 },
      { station: 'Samedan', km: 82.0 },
      { station: 'St. Moritz', km: 89.0 },
    ],
  },
  {
    slug: 'berninabanen',
    name: 'Berninabanen',
    aliases: ['Berninabahn', 'Bernina Express', 'St. Moritz–Tirano'],
    countries: ['CH', 'IT'],
    points: [
      { station: 'St. Moritz', km: 0 },
      { station: 'Pontresina', km: 6.0 },
      { station: 'Ospizio Bernina', km: 28.0 },
      { station: 'Alp Grüm', km: 33.0 },
      { station: 'Poschiavo', km: 46.0 },
      { station: 'Tirano', km: 61.0 },
    ],
  },
  {
    slug: 'rheintal-ch',
    name: 'St. Gallen–Chur',
    aliases: ['Rheintalbanen', 'Sankt Gallen–Chur', 'Sargans-korridoren'],
    countries: ['CH'],
    points: [
      { station: 'St. Gallen', km: 0 },
      { station: 'Altstätten', km: 30.0 },
      { station: 'Buchs SG', km: 55.0 },
      { station: 'Sargans', km: 73.0 },
      { station: 'Chur', km: 105.0 },
    ],
  },
  {
    slug: 'liechtenstein-bahn',
    name: 'Feldkirch–Buchs',
    aliases: ['Liechtensteinbanen', 'Buchs–Schaan-Vaduz', 'Liechtenstein'],
    countries: ['CH', 'LI', 'AT'],
    points: [
      { station: 'Buchs SG', km: 0 },
      { station: 'Schaan-Vaduz', km: 4.0 },
      { station: 'Nendeln', km: 8.0 },
      { station: 'Feldkirch', km: 18.0 },
    ],
  },
  {
    slug: 'voralpen-express',
    name: 'Voralpen-Express',
    aliases: ['Voralpenexpress', 'Luzern–St. Gallen'],
    countries: ['CH'],
    points: [
      { station: 'Luzern', km: 0 },
      { station: 'Arth-Goldau', km: 30.0 },
      { station: 'Pfäffikon SZ', km: 60.0 },
      { station: 'Rapperswil', km: 68.0 },
      { station: 'Wattwil', km: 100.0 },
      { station: 'St. Gallen', km: 130.0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// France, Italy and the Channel
// ---------------------------------------------------------------------------

const SOUTHWEST_EUROPE: RailwayLine[] = [
  {
    slug: 'hs1',
    name: 'High Speed 1',
    aliases: ['HS1', 'Channel Tunnel Rail Link', 'CTRL', 'London–Calais'],
    countries: ['GB', 'FR'],
    notes: 'Carries the Channel Tunnel crossing between the Cheriton and Coquelles portals.',
    points: [
      { station: 'London St. Pancras', km: 0 },
      { station: 'Ebbsfleet International', km: 32.0 },
      { station: 'Ashford International', km: 90.0 },
      { station: 'Cheriton', km: 105.0 },
      { station: 'Coquelles', km: 155.0 },
      { station: 'Calais-Fréthun', km: 160.0 },
    ],
  },
  {
    slug: 'lgv-nord',
    name: 'LGV Nord',
    aliases: ['LGV Nord Europe', 'Calais–Paris', 'Lille–Paris'],
    countries: ['FR'],
    points: [
      { station: 'Calais-Fréthun', km: 0 },
      { station: 'Lille-Europe', km: 110.0 },
      { station: 'Paris Nord', km: 331.0 },
    ],
  },
  {
    slug: 'lgv-1',
    name: 'LGV 1',
    aliases: ['HSL 1', 'Lille–Brussel', 'Lille–Bruxelles'],
    countries: ['FR', 'BE'],
    points: [
      { station: 'Lille-Europe', km: 0 },
      { station: 'Antoing', km: 30.0 },
      { station: 'Bruxelles-Midi - Brussel-Zuid', km: 105.0 },
    ],
  },
  {
    slug: 'lgv-interconnexion-est',
    name: 'LGV Interconnexion Est',
    aliases: ['Interconnexion Est', 'Marne-la-Vallée–Lille'],
    countries: ['FR'],
    points: [
      { station: 'Marne-la-Vallée Chessy', km: 0 },
      { station: 'Aéroport Charles de Gaulle 2', km: 25.0 },
      { station: 'Lille-Europe', km: 227.0 },
    ],
  },
  {
    slug: 'rer-a',
    name: 'RER A',
    aliases: ['RER-A', 'Paris RER A'],
    countries: ['FR'],
    points: [
      { station: 'Nation', km: 0 },
      { station: 'Vincennes', km: 3.0 },
      { station: 'Noisy-le-Grand', km: 14.0 },
      { station: "Val d'Europe", km: 30.0 },
      { station: 'Marne-la-Vallée Chessy', km: 32.0 },
      { station: 'Marne-la-Vallée Chessy - Parcs Disneyland (RER)', km: 32.1 },
    ],
  },
  {
    slug: 'lgv-est-europeenne',
    name: 'LGV Est européenne',
    aliases: ['LGV Est', 'Paris–Strasbourg', 'POS'],
    countries: ['FR', 'DE'],
    points: [
      { station: 'Paris Est', km: 0 },
      { station: 'Strasbourg-Ville', km: 440.0 },
      { station: 'Karlsruhe Hbf', km: 522.0 },
    ],
  },
  {
    slug: 'lgv-sud-est',
    name: 'LGV Sud-Est',
    aliases: ['LGV Méditerranée', 'Paris–Marseille', 'LGV Sud Est'],
    countries: ['FR'],
    points: [
      { station: 'Paris Gare de Lyon', km: 0 },
      { station: 'Lyon Part-Dieu', km: 427.0 },
      { station: 'Avignon TGV', km: 690.0 },
      { station: 'Marseille St-Charles', km: 750.0 },
    ],
  },
  {
    slug: 'cote-dazur',
    name: 'Marseille–Ventimiglia',
    aliases: ['Côte d’Azur', 'Cote d Azur', 'Marseille–Vintimille', 'Rivieralinja'],
    countries: ['FR', 'IT'],
    points: [
      { station: 'Marseille St-Charles', km: 0 },
      { station: 'Toulon', km: 65.0 },
      { station: 'Cannes', km: 190.0 },
      { station: 'Nice-Ville', km: 223.0 },
      { station: 'Monaco - Monte Carlo', km: 239.0 },
      { station: 'Ventimiglia', km: 262.0 },
    ],
  },
  {
    slug: 'genova-ventimiglia',
    name: 'Genova–Ventimiglia',
    aliases: ['Ferrovia Genova–Ventimiglia', 'Genova-Ventimiglia'],
    countries: ['IT'],
    points: [
      { station: 'Genova Piazza Principe', km: 0 },
      { station: 'Savona', km: 45.0 },
      { station: 'Imperia', km: 105.0 },
      { station: 'Sanremo', km: 130.0 },
      { station: 'Ventimiglia', km: 155.0 },
    ],
  },
  {
    slug: 'milano-genova',
    name: 'Milano–Genova',
    aliases: ['Milano-Genova', 'Ferrovia Milano–Genova'],
    countries: ['IT'],
    points: [
      { station: 'Milano Centrale', km: 0 },
      { station: 'Pavia', km: 35.0 },
      { station: 'Genova Piazza Principe', km: 145.0 },
    ],
  },
  {
    slug: 'milano-venezia',
    name: 'Milano–Venezia',
    aliases: ['Ferrovia Milano–Venezia', 'Milano-Venezia'],
    countries: ['IT'],
    points: [
      { station: 'Milano Centrale', km: 0 },
      { station: 'Milano Lambrate', km: 4.0 },
      { station: 'Brescia', km: 95.0 },
      { station: 'Verona Porta Nuova', km: 160.0 },
      { station: 'Padova', km: 234.0 },
      { station: 'Venezia Mestre', km: 260.0 },
    ],
  },
  {
    slug: 'milano-lecco',
    name: 'Milano–Lecco',
    aliases: ['Milano-Lecco', 'Ferrovia Milano–Lecco'],
    countries: ['IT'],
    points: [
      { station: 'Milano Centrale', km: 0 },
      { station: 'Monza', km: 15.0 },
      { station: 'Lecco', km: 50.0 },
    ],
  },
  {
    slug: 'venezia-udine',
    name: 'Venezia–Udine',
    aliases: ['Venezia-Udine'],
    countries: ['IT'],
    points: [
      { station: 'Venezia Mestre', km: 0 },
      { station: 'Treviso', km: 27.0 },
      { station: 'Udine', km: 130.0 },
    ],
  },
  {
    slug: 'pontebbana',
    name: 'Pontebbana',
    aliases: ['Udine–Villach', 'Tarvisio-linja'],
    countries: ['IT', 'AT'],
    points: [
      { station: 'Udine', km: 0 },
      { station: 'Gemona', km: 45.0 },
      { station: 'Tarvisio Boscoverde', km: 85.0 },
      { station: 'Villach Hbf', km: 110.0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Great Britain
// ---------------------------------------------------------------------------

const BRITAIN: RailwayLine[] = [
  {
    slug: 'ecml',
    name: 'East Coast Main Line',
    aliases: ['ECML', 'Austkystbanen', 'London–Edinburgh'],
    countries: ['GB'],
    points: [
      { station: "London King's Cross", km: 0 },
      { station: 'Peterborough', km: 122.0 },
      { station: 'Doncaster', km: 251.0 },
      { station: 'York', km: 303.0 },
      { station: 'Darlington', km: 364.0 },
      { station: 'Newcastle', km: 432.0 },
      { station: 'Edinburgh Waverley', km: 632.0 },
    ],
  },
  {
    slug: 'wcml',
    name: 'West Coast Main Line',
    aliases: ['WCML', 'Vestkystbanen', 'London–Glasgow'],
    countries: ['GB'],
    points: [
      { station: 'London Euston', km: 0 },
      { station: 'Crewe', km: 254.0 },
      { station: 'Warrington Bank Quay', km: 290.0 },
      { station: 'Preston', km: 336.0 },
      { station: 'Carlisle', km: 486.0 },
      { station: 'Glasgow Central', km: 645.0 },
    ],
  },
  {
    slug: 'gwml',
    name: 'Great Western Main Line',
    aliases: ['GWML', 'London–Penzance', 'Cornish Main Line'],
    countries: ['GB'],
    points: [
      { station: 'London Paddington', km: 0 },
      { station: 'Reading', km: 58.0 },
      { station: 'Didcot Parkway', km: 85.0 },
      { station: 'Swindon', km: 124.0 },
      { station: 'Bristol Parkway', km: 180.0 },
      { station: 'Taunton', km: 260.0 },
      { station: 'Exeter St Davids', km: 280.0 },
      { station: 'Plymouth', km: 360.0 },
      { station: 'Truro', km: 460.0 },
      { station: 'Penzance', km: 493.0 },
    ],
  },
  {
    slug: 'cherwell-valley-line',
    name: 'Cherwell Valley Line',
    aliases: ['Reading–Oxford', 'Oxford line'],
    countries: ['GB'],
    points: [
      { station: 'Reading', km: 0 },
      { station: 'Didcot Parkway', km: 27.0 },
      { station: 'Oxford', km: 44.0 },
    ],
  },
  {
    slug: 'bristol-birmingham',
    name: 'Bristol–Birmingham',
    aliases: ['Cross Country Route', 'Birmingham–Bristol'],
    countries: ['GB'],
    points: [
      { station: 'Bristol Parkway', km: 0 },
      { station: 'Cheltenham Spa', km: 60.0 },
      { station: 'Worcester', km: 95.0 },
      { station: 'Birmingham New Street', km: 145.0 },
    ],
  },
  {
    slug: 'grand-junction',
    name: 'Birmingham–Crewe',
    aliases: ['Grand Junction Railway', 'Birmingham-Crewe'],
    countries: ['GB'],
    points: [
      { station: 'Birmingham New Street', km: 0 },
      { station: 'Wolverhampton', km: 30.0 },
      { station: 'Stafford', km: 70.0 },
      { station: 'Crewe', km: 100.0 },
    ],
  },
  {
    slug: 'north-wales-coast-line',
    name: 'North Wales Coast Line',
    aliases: ['Nord-Wales-kystbanen', 'Crewe–Holyhead', 'Chester–Holyhead'],
    countries: ['GB'],
    points: [
      { station: 'Crewe', km: 0 },
      { station: 'Chester', km: 34.0 },
      { station: 'Rhyl', km: 78.0 },
      { station: 'Llandudno Junction', km: 105.0 },
      { station: 'Conwy', km: 108.0 },
      { station: 'Bangor', km: 130.0 },
      { station: 'Holyhead', km: 170.0 },
    ],
  },
  {
    slug: 'llandudno-branch',
    name: 'Llandudno Branch',
    aliases: ['Llandudno-greina', 'Llandudno Junction–Llandudno'],
    countries: ['GB'],
    points: [
      { station: 'Llandudno Junction', km: 0 },
      { station: 'Deganwy', km: 2.0 },
      { station: 'Llandudno', km: 5.0 },
    ],
  },
  {
    slug: 'conwy-valley-line',
    name: 'Conwy Valley Line',
    aliases: ['Conwy-dalbanen', 'Llandudno Junction–Blaenau Ffestiniog'],
    countries: ['GB'],
    points: [
      { station: 'Llandudno Junction', km: 0 },
      { station: 'Betws-y-Coed', km: 27.0 },
      { station: 'Blaenau Ffestiniog', km: 44.0 },
    ],
  },
  {
    slug: 'tees-valley-line',
    name: 'Tees Valley Line',
    aliases: ['Darlington–Saltburn', 'Tees-dalbanen'],
    countries: ['GB'],
    points: [
      { station: 'Darlington', km: 0 },
      { station: 'Middlesbrough', km: 24.0 },
      { station: 'Redcar', km: 40.0 },
    ],
  },
  {
    slug: 'esk-valley-line',
    name: 'Esk Valley Line',
    aliases: ['Esk-dalbanen', 'Middlesbrough–Whitby'],
    countries: ['GB'],
    points: [
      { station: 'Middlesbrough', km: 0 },
      { station: 'Nunthorpe', km: 12.0 },
      { station: 'Battersby', km: 26.0 },
      { station: 'Glaisdale', km: 45.0 },
      { station: 'Whitby', km: 56.0 },
    ],
  },
  {
    slug: 'north-yorkshire-moors-railway',
    name: 'North Yorkshire Moors Railway',
    aliases: ['NYMR', 'Whitby–Pickering'],
    countries: ['GB'],
    points: [
      { station: 'Whitby', km: 0 },
      { station: 'Grosmont', km: 10.0 },
      { station: 'Goathland', km: 16.0 },
      { station: 'Pickering', km: 39.0 },
    ],
  },
  {
    slug: 'west-highland-line',
    name: 'West Highland Line',
    aliases: ['Vesthøglandsbanen', 'Glasgow–Mallaig', 'Fort William–Mallaig'],
    countries: ['GB'],
    points: [
      { station: 'Glasgow Central', km: 0 },
      { station: 'Crianlarich', km: 92.0 },
      { station: 'Fort William', km: 196.0 },
      { station: 'Glenfinnan', km: 220.0 },
      { station: 'Mallaig', km: 264.0 },
    ],
  },
  {
    slug: 'highland-main-line',
    name: 'Highland Main Line',
    aliases: ['Høglandsbanen', 'Inverness–Perth'],
    countries: ['GB'],
    points: [
      { station: 'Inverness', km: 0 },
      { station: 'Aviemore', km: 55.0 },
      { station: 'Pitlochry', km: 130.0 },
      { station: 'Perth', km: 190.0 },
      { station: 'Stirling', km: 240.0 },
    ],
  },
  {
    slug: 'stirling-edinburgh',
    name: 'Stirling–Edinburgh',
    aliases: ['Stirling-Edinburgh', 'Falkirk-linja'],
    countries: ['GB'],
    points: [
      { station: 'Stirling', km: 0 },
      { station: 'Falkirk Grahamston', km: 25.0 },
      { station: 'Edinburgh Waverley', km: 59.0 },
    ],
  },
]

export const LINES: RailwayLine[] = [
  ...NORWAY,
  ...SWEDEN,
  ...DENMARK,
  ...CENTRAL_EUROPE,
  ...SWITZERLAND,
  ...SOUTHWEST_EUROPE,
  ...BRITAIN,
]

/**
 * The named bridges and tunnels, each a span on a carrier line.
 *
 * A leg crosses one when its own span on that carrier covers the crossing end to
 * end — so a London→Bruxelles run counts the Channel Tunnel even though neither
 * endpoint is anywhere near a portal, and a København→Malmö run counts the Øresund
 * link once in each direction rather than once per day out.
 */
export const CROSSINGS: Crossing[] = [
  {
    slug: 'oresundsbroa',
    name: 'Øresundsbroa',
    aliases: ['Öresundsbron', 'Øresundsbroen', 'Öresundsbroa', 'Öresund Bridge', 'Øresundsforbindelsen', 'Øresundsbrua', 'Öresundsförbindelsen'],
    countries: ['DK', 'SE'],
    carrier: 'oresundsbanan',
    fromKm: 12.8,
    toKm: 36.8,
    notes: 'The whole fixed link — Drogden tunnel, Peberholm and the bridge — counted as one crossing.',
  },
  {
    slug: 'storebeltsbrua',
    name: 'Storebeltsbrua',
    aliases: ['Storebæltsbroen', 'Storebæltsforbindelsen', 'Great Belt Bridge', 'Storebælt', 'Storebeltsambandet', 'Storebaeltsbroen'],
    countries: ['DK'],
    carrier: 'vestbanen',
    fromKm: 110.0,
    toKm: 128.0,
  },
  {
    slug: 'kanaltunnelen',
    name: 'Kanaltunnelen',
    aliases: ['Channel Tunnel', 'Eurotunnel', 'Tunnel sous la Manche', 'Chunnel', 'Den engelske kanaltunnelen'],
    countries: ['GB', 'FR'],
    carrier: 'hs1',
    fromKm: 105.0,
    toKm: 155.0,
  },
  {
    slug: 'ulrikstunnelen',
    name: 'Ulrikstunnelen',
    aliases: ['Ulriken tunnel', 'Ulrikentunnelen', 'Ulriken'],
    countries: ['NO'],
    carrier: 'bergensbanen',
    fromKm: 1.6,
    toKm: 9.3,
  },
  {
    slug: 'romeriksporten',
    name: 'Romeriksporten',
    aliases: ['Romeriksportens tunnel'],
    countries: ['NO'],
    carrier: 'gardermobanen',
    fromKm: 3.0,
    toKm: 17.0,
  },
  {
    slug: 'lotschberg-basistunnelen',
    name: 'Lötschberg-basistunnelen',
    aliases: ['Lötschberg Base Tunnel', 'Lotschberg basistunnel', 'Lötschbergbasistunnel'],
    countries: ['CH'],
    carrier: 'lotschbergbahn',
    fromKm: 55.0,
    toKm: 90.0,
  },
]

/**
 * Pinned routings, each because the arithmetic alone would answer badly.
 *
 * The Hønefoss pair is the interesting one: via Roa the registry makes it 98 km and
 * via Drammen 112.5, so the shortest path picks Roa *confidently* — and is wrong, as
 * viaduct's own 112 km shows. A confidently wrong answer is worse than an ambiguous
 * one, which is why the escape hatch is not only for ties.
 */
export const OVERRIDES: RouteOverride[] = [
  {
    from: 'Bergen',
    to: 'Oslo S',
    lines: ['bergensbanen', 'randsfjordbanen', 'sorlandsbanen', 'drammenbanen'],
    reason: 'Vy runs Bergensbanen into Oslo via Hønefoss, Hokksund and Drammen. The Roa route is 14 km shorter on paper and would otherwise win.',
  },
  {
    from: 'Oslo S',
    to: 'Hønefoss',
    lines: ['drammenbanen', 'sorlandsbanen', 'randsfjordbanen'],
    reason: 'Via Drammen, matching the 112 km viaduct records. The Roa route measures 98 km and would be picked outright.',
  },
  {
    from: 'Oslo S',
    to: 'Trondheim',
    lines: ['gardermobanen', 'dovrebanen'],
    reason: 'Via Dovre. Rørosbanen reaches Trondheim within 4% of the same distance, so the two tie without this.',
  },
  {
    from: 'Ål',
    to: 'Bergen',
    lines: ['bergensbanen'],
    reason: 'Wholly on Bergensbanen; pinned so the partial-line case is settled rather than inferred.',
  },
]

/**
 * A stable fingerprint of everything above.
 *
 * Stored on each `trip_routes` row so that changing a kilometre post, adding a line
 * or writing an override invalidates every number derived from the old version at
 * once. Nothing ends up half-migrated, and re-resolving 230 trips costs milliseconds.
 *
 * FNV-1a over the canonical JSON — not for security, only for change detection.
 */
export function registryVersion(): string {
  const canonical = JSON.stringify([LINES, CROSSINGS, OVERRIDES])
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `v1-${hash.toString(16).padStart(8, '0')}`
}

/** Every registry entry as one list — lines and crossings share a name space. */
export function allEntries(): Array<
  | ({ kind: 'line' } & RailwayLine)
  | ({ kind: 'crossing' } & Crossing)
> {
  return [
    ...LINES.map((l) => ({ kind: 'line' as const, ...l })),
    ...CROSSINGS.map((c) => ({ kind: 'crossing' as const, ...c })),
  ]
}

/** Registry length of a line: the distance between its first and last kilometre post. */
export function lineLengthKm(line: RailwayLine): number {
  if (line.points.length < 2) return 0
  return line.points[line.points.length - 1]!.km - line.points[0]!.km
}
