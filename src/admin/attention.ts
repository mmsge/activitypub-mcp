import type { TokenStatus } from '../lib/source-health.js'
import { categoryHref } from './categories.js'

// "Treng merksemd": the problems Oversikt leads with. A pure function of counts the
// dashboard query already gathers, so the rules are tested without a database.
//
// Each rule deep-links to where the cause is visible. The order is the severity order:
// red before yellow, so the first card is always the one to look at first.

export type AttentionTone = 'red' | 'yellow'

export interface AttentionItem {
  id: 'linkedin' | 'delivery' | 'enrichment' | 'follows'
  tone: AttentionTone
  title: string
  sub: string
  help: string
  action: string
  href: string
}

export interface AttentionInput {
  linkedinStatus: TokenStatus
  linkedinLastSuccessAt: Date | null
  linkedinLastHttpStatus: number | null
  /** Outgoing requests answered with status >= 400 in the last 24 hours. */
  deliveryErrors24h: number
  failedEnrichment: number
  /** actor_ap_id of every pending follow, oldest first. */
  pendingFollowActors: string[]
}

/** `https://host/users/name` → `@name@host`; anything else is shown as its host. */
export function actorHandle(apId: string): string {
  try {
    const u = new URL(apId)
    const name = u.pathname.split('/').filter(Boolean).pop()
    return name ? `@${name.replace(/^@/, '')}@${u.host}` : u.host
  } catch {
    return apId
  }
}

const DAY_MONTH = new Intl.DateTimeFormat('nn-NO', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Oslo',
})

/** "28. okt." in Oslo time. */
export function shortDate(d: Date): string {
  return DAY_MONTH.format(d)
}

export function attentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = []

  if (input.linkedinStatus === 'unauthorized') {
    const parts = [
      input.linkedinLastSuccessAt ? `Sist OK ${shortDate(input.linkedinLastSuccessAt)}` : 'Aldri OK',
    ]
    if (input.linkedinLastHttpStatus !== null) parts.push(`HTTP ${input.linkedinLastHttpStatus}`)
    items.push({
      id: 'linkedin',
      tone: 'red',
      title: 'LinkedIn-tokenet blir avvist',
      sub: parts.join(' · '),
      help:
        'DMA-tokenet er ikkje gyldig lenger. Lag eit nytt i LinkedIn Developers, legg det i .env som ' +
        'LINKEDIN_DMA_TOKEN og køyr npm run sync-linkedin. Dataa som alt er lagra er framleis gyldige.',
      action: 'Opne LinkedIn',
      href: categoryHref('linkedin'),
    })
  }

  if (input.deliveryErrors24h > 0) {
    const n = input.deliveryErrors24h
    items.push({
      id: 'delivery',
      tone: 'red',
      title: `${n} leveringsfeil`,
      sub: 'Siste 24 timar',
      help:
        'Utgåande førespurnader som fekk feil svar. Loggane filtrert på utgåande viser kva tenar ' +
        'som svarte og kvifor.',
      action: 'Sjå loggar',
      href: '/admin/logs?direction=outbound',
    })
  }

  if (input.failedEnrichment > 0) {
    const n = input.failedEnrichment
    items.push({
      id: 'enrichment',
      tone: 'yellow',
      title: `${n} ${n === 1 ? 'feila berikning' : 'feila berikingar'}`,
      sub: 'Metadata frå NeoDB',
      help:
        'Metadata kunne ikkje hentast. «Berik på nytt» prøver éi og éi; NeoDB-synk prøver alle. ' +
        'Skjulte rader er ikkje talde med.',
      action: 'Opne Sjåing',
      href: '/admin/media?tab=other&health=failed',
    })
  }

  if (input.pendingFollowActors.length > 0) {
    const n = input.pendingFollowActors.length
    const first = actorHandle(input.pendingFollowActors[0]!)
    items.push({
      id: 'follows',
      tone: 'yellow',
      title: `${n} ${n === 1 ? 'følgje ventar' : 'følgjer ventar'}`,
      sub: n > 1 ? `${first}, +${n - 1}` : first,
      help:
        'Følgjeførespurnader som ikkje er godkjende enno. Det kan ta frå nokre minutt til nokre timar.',
      action: 'Sjå følgjer',
      href: '/admin/follows',
    })
  }

  return items
}
