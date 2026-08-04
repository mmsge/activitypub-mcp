/**
 * A bounded TTL cache with single-flight loading.
 *
 * `src/admin/media-query.ts` already memoises its expensive derivation, but that
 * cache is keyed on a closed set of actor ids behind an admin session. This one
 * backs a public URL on a 3.7 GB box shared with ~22 containers, so it is bounded
 * on both axes: entries expire, and the map has a hard size cap with oldest-first
 * eviction.
 *
 * The cap is a backstop, not the defence. The real protection is that callers
 * normalise every filter to a closed enum before building a key, so the key space
 * is small by construction and a crawler cannot mint unbounded distinct entries.
 *
 * Single-flight matters more than it looks: without it, a cold key hit by twenty
 * concurrent requests runs the query twenty times. The in-flight promise is stored
 * and shared, and dropped if it rejects so a transient failure is not cached.
 */
export interface TtlMemo<V> {
  get(key: string, load: () => Promise<V>): Promise<V>
  /** Drop everything. Used by tests and by the admin re-render button. */
  clear(): void
  size(): number
}

interface Entry<V> {
  at: number
  value: V
}

export function ttlMemo<V>(opts: { ttlMs: number; max: number }): TtlMemo<V> {
  // Insertion-ordered, which is what makes "evict the oldest" a shift of the first key.
  const entries = new Map<string, Entry<V>>()
  const inflight = new Map<string, Promise<V>>()

  function evictIfNeeded(): void {
    while (entries.size > opts.max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  return {
    async get(key, load) {
      const hit = entries.get(key)
      if (hit && Date.now() - hit.at < opts.ttlMs) return hit.value
      if (hit) entries.delete(key)

      const running = inflight.get(key)
      if (running) return running

      const promise = load()
        .then((value) => {
          entries.set(key, { at: Date.now(), value })
          evictIfNeeded()
          return value
        })
        .finally(() => {
          // Always clear, so a rejection is retried rather than remembered.
          inflight.delete(key)
        })
      inflight.set(key, promise)
      return promise
    },
    clear() {
      entries.clear()
      inflight.clear()
    },
    size() {
      return entries.size
    },
  }
}
