/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
import { liveTicket, type Thread } from '../core/index.ts'
import type { SourceContext } from './host.ts'

/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id))
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? '')]
    .map(Date.parse).filter(Number.isFinite)
  return now - Math.max(...times) < POLL_HORIZON_MS
}
/**
 * Steps a poll start timestamp back by `overlapMs` (5 seconds unless given) so late-arriving remote events are not missed;
 * deterministic trigger IDs deduplicate overlaps.
 */
export const cursorAt = (started: string, overlapMs = 5000): string => new Date(Date.parse(started) - overlapMs).toISOString()
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
export async function pollThreads(ctx: SourceContext, source: string, stopped: () => boolean, poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false): Promise<void> {
  for (const thread of ctx.threads.subscribed(source)) {
    if (stopped()) return
    if (skip(thread) || !polled(ctx, thread)) continue
    try {
      await poll(thread)
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      ctx.threads.patch(thread.key, { pollError: String(error) })
    }
  }
}
/**
 * A request to poll now, for one Source instance's loop. `wake()` ends a pause in progress, or, when the loop is mid-round,
 * makes exactly one more round run right after it; several wakes before the loop looks count as one.
 */
export class Waker {
  private pending = false
  private listener: (() => void) | undefined
  wake(): void { this.pending = true; this.listener?.() }
  /** Takes the pending wake, if any. */
  take(): boolean { const pending = this.pending; this.pending = false; return pending }
  /** Calls `listener` on the next wake (or at once when one is pending), until the returned function removes it. */
  on(listener: () => void): () => void {
    this.listener = listener
    if (this.pending) listener()
    return () => { if (this.listener === listener) this.listener = undefined }
  }
}
/** The shortest gap a wake leaves between the end of one round and the start of the next. */
export const WAKE_MIN_MS = 5000
/**
 * What ended a pause: a wake (`POST sources/:id/poll`), its own time running out with no wake pending, or the signal. A wake
 * pending when the time runs out counts as a wake, since the round that follows is the one it asked for.
 */
export type PauseEnd = 'wake' | 'timer' | 'abort'
/**
 * Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. With `waker`, a
 * wake ends the wait early, though never before `minMs` has passed. Resolves with what ended it.
 */
export function pause(ms: number, signal: AbortSignal, waker?: Waker, minMs = WAKE_MIN_MS): Promise<PauseEnd> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('abort'); return }
    const started = Date.now()
    let early: ReturnType<typeof setTimeout> | undefined
    let off = () => {}
    const done = (end: PauseEnd) => {
      clearTimeout(timer); clearTimeout(early); off(); signal.removeEventListener('abort', aborted); resolve(end)
    }
    const aborted = () => { done('abort') }
    const timer = setTimeout(() => { done(waker?.take() ? 'wake' : 'timer') }, ms)
    signal.addEventListener('abort', aborted, { once: true })
    if (waker) off = waker.on(() => {
      if (early !== undefined) return
      early = setTimeout(() => { waker.take(); done('wake') }, Math.max(0, Math.min(ms, minMs) - (Date.now() - started)))
    })
  })
}
