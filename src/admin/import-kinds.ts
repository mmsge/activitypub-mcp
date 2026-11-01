import type { CategoryId } from './categories.js'

// Every import and maintenance run the admin offers, in one list (ADR 0073, phase 3).
// `id` is also the path segment of the POST that runs it (`/admin/import/:id`) and of
// the page that explains it (GET `/admin/import/:id`), so the two cannot drift.

export interface ImportField {
  name: string
  label: string
  placeholder?: string
  required?: boolean
  /** Suggestions shown as a datalist. */
  suggestions?: string[]
  /** Prefilled value. */
  value?: string
}

export interface ImportKind {
  id: string
  category: CategoryId
  /** "Import" for a file, "Hent" for a crawl, "Køyr" for maintenance. */
  verb: 'Import' | 'Hent' | 'Køyr'
  label: string
  sub: string
  /** The form field holding the upload; absent for runs that take no file. */
  fileField?: string
  /** The `accept` attribute, shown under the file picker too. */
  accept?: string
  fields?: ImportField[]
  /** The ⓘ text, a paragraph per entry. */
  help: string[]
  /** The primary button's label. */
  primary: string
  /**
   * Shown as a preview first: run in a rolled-back transaction, then confirmed. Only for
   * imports whose every effect is in this database (ADR 0073).
   */
  preview?: boolean
}

export const IMPORT_KINDS: ImportKind[] = [
  {
    id: 'storygraph',
    category: 'lesing',
    verb: 'Import',
    label: 'StoryGraph-lesedatoar',
    sub: 'CSV-eksport frå StoryGraph',
    fileField: 'file',
    accept: '.csv,text/csv',
    fields: [{ name: 'actor', label: 'BookWyrm-konto', placeholder: '@brukar@vert eller URL', required: true }],
    help: [
      'Last ned frå StoryGraph: Manage account → Export StoryGraph library. Kvart intervall i «Dates Read» blir ei eiga lesing, kopla til BookWyrm-boka med ISBN-13, elles tittel og forfattar.',
      'Ein StoryGraph-dato fyller berre det BookWyrm manglar. Er dei usamde, vinn BookWyrm, og resultatet listar konflikten. Berre datoar blir lesne. Same fil på nytt endrar ingenting (ADR 0063).',
    ],
    primary: 'Førehandsvis',
    preview: true,
  },
  {
    id: 'youtube',
    category: 'sjaaing',
    verb: 'Import',
    label: 'YouTube-historikk',
    sub: 'JSON frå Google Takeout',
    fileField: 'file',
    accept: '.json,application/json',
    fields: [
      { name: 'account', label: 'Konto (om fila ikkje har nokon)' },
      { name: 'source', label: 'Kjelde', placeholder: 't.d. takeout-2026-08' },
    ],
    help: [
      'watch-history.json frå Takeout (YouTube og YouTube Music → historikk). Idempotent på konto, video og lokalt minutt, så ein overlappande eksport legg berre til det som manglar.',
      'Det fulle arkivet på ~46 MB bør gå via kommandolinja: npm run import-youtube-watches -- <sti>. Opplastinga her blir lesen inne i tenaren, så ei stor nok fil kan ta tenaren ned med seg.',
    ],
    primary: 'Førehandsvis',
    preview: true,
  },
  {
    id: 'repair-neodb',
    category: 'sjaaing',
    verb: 'Køyr',
    label: 'Reparer NeoDB-merke',
    sub: 'Vedlikehald, trygt å køyre fleire gonger',
    help: [
      'Byggjer opp att det lagra NeoDB-merke skulle ha gitt: manglande posttekst, merkelageret og berikning av kvar katalogoppføring merka peikar på. Fyller berre tomme hylledatoar.',
      'Ingenting blir merka på nytt på NeoDB, og ingen post blir federert på nytt.',
    ],
    primary: 'Køyr no',
  },
  {
    id: 'trips',
    category: 'reiser',
    verb: 'Import',
    label: 'Togturar',
    sub: 'CSV frå viaduct.world',
    fileField: 'file',
    accept: '.csv,text/csv',
    help: [
      'Ein tur er kjend på avgangstid og dei to stasjonane, så ein ny eksport etter reisa oppdaterer den lagra turen i staden for å lagre han to gonger. Ein uendra eksport skriv ingenting.',
      'Resultatet listar òg lagra turar som manglar i fila. Ingenting blir sletta før du stadfestar det der, og berre turar mellom første og siste avgang i fila kan fjernast (ADR 0054).',
    ],
    primary: 'Førehandsvis',
    preview: true,
  },
  {
    id: 'trip-tracks',
    category: 'reiser',
    verb: 'Import',
    label: 'Togruter',
    sub: 'GPX frå viaduct.world',
    fileField: 'file',
    accept: '.gpx,application/gpx+xml',
    help: [
      'GPX-eksporten med alle år. Kvart spor er lina éin etappe teikna, kopla til CSV-turen med same stasjonar og lokale avgangstid. Stasjonspunkta blir lagra ved sida av, ikkje over, dei geokoda stasjonane.',
      'Fila er heile settet: ei rute eller eit punkt som ikkje lenger er med, blir fjerna. Ei fil utan lesbare spor blir avvist (ADR 0070).',
    ],
    primary: 'Førehandsvis',
    preview: true,
  },
  {
    id: 'archive',
    category: 'fediverse',
    verb: 'Import',
    label: 'Mastodon-arkiv',
    sub: 'outbox.json frå arkivet',
    fileField: 'archive',
    accept: '.json',
    help: [
      'Be om arkivet under Mastodon → Innstillingar → Eksport. Pakk ut .tar.gz-fila og last opp outbox.json.',
      'Denne importen har inga førehandsvising: han hentar aktørar og set i gang berikingar medan han køyrer, og det kan ikkje rullast tilbake.',
    ],
    primary: 'Importer',
  },
  {
    id: 'crawl',
    category: 'fediverse',
    verb: 'Hent',
    label: 'Hent utboks',
    sub: 'Les ein aktør si utboks over ActivityPub',
    fields: [{ name: 'handle', label: 'Aktør', placeholder: '@brukar@instans.social', required: true }],
    help: [
      'Hentar heile den offentlege posthistorikken til ein aktør. Verkar med Mastodon og BookWyrm. Store kontoar kan ta eit minutt (opptil 200 sider).',
    ],
    primary: 'Hent',
  },
  {
    id: 'reprocess',
    category: 'fediverse',
    verb: 'Køyr',
    label: 'Prosesser nakne objekt',
    sub: 'Vedlikehald, trygt å køyre fleire gonger',
    help: [
      'Køyrer prosesseringa på nytt for aktivitetar lagra som nakne Note-, Review- og liknande objekt (t.d. frå ei BookWyrm-utboks), så dei blir søkbare innlegg.',
    ],
    primary: 'Køyr no',
  },
  {
    id: 'linkedin',
    category: 'linkedin',
    verb: 'Import',
    label: 'LinkedIn-statistikk',
    sub: 'XLSX frå LinkedIn',
    fileField: 'file',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    help: [
      'Content-eksporten frå analysepanelet (siste 90 dagar er ei god standard). Visningar og engasjement per innlegg blir lesne frå arket TOP POSTS og lagra éi rad per innlegg per eksport.',
      'Eksporten er datert etter sitt eige rapportvindauge, så same fil to gonger er trygt.',
    ],
    primary: 'Førehandsvis',
    preview: true,
  },
]

export function importKind(id: string): ImportKind | undefined {
  return IMPORT_KINDS.find((k) => k.id === id)
}
