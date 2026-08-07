/**
 * A liveness beat for the background scheduler.
 *
 * `/health` needs at least one check that would actually catch a real failure, and
 * the most useful one here is "are the timers still firing?". Every background job
 * in this app hangs off setInterval in src/jobs/scheduler.ts; if the delivery loop
 * stops, nothing else notices — the HTTP surface keeps answering, the database keeps
 * responding, and posts simply stop being delivered and scrobbles stop being
 * ingested. An in-process beat is the cheapest honest signal for that: it costs one
 * assignment per tick and requires no extra table.
 *
 * Deliberately in-process rather than a database column: this reports on *this*
 * container's timers, which is the thing that can silently die. A stored timestamp
 * would also be satisfied by some other process having run recently.
 */
let lastTickMs: number | null = null

/** Called at the top of the scheduler's shortest interval, before the work runs. */
export function markSchedulerTick(): void {
  lastTickMs = Date.now()
}

/** Epoch ms of the last tick, or null if the scheduler has never fired. */
export function lastSchedulerTick(): number | null {
  return lastTickMs
}

/** Test seam. */
export function resetSchedulerTick(): void {
  lastTickMs = null
}
