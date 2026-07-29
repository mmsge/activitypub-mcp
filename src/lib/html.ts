/** Escapes a string for interpolation into HTML text or a quoted attribute.
 *
 *  Used for the values we render into the actor's bio and profile page, which are
 *  partly config-derived rather than hardcoded. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
