/**
 * EventBus: durable pub/sub with SQLite backing.
 *
 * Ported from yodoca/core/events/bus.py.
 *
 * Architecture:
 *   publish() → journal (SQLite) → dispatch loop → handler(s)
 *
 * The dispatch loop polls the journal and delivers events to in-memory
 * subscribers. Failed handlers are retried up to maxRetries times before
 * the event is dead-lettered. A watchdog task periodically recovers events
 * that got stuck in 'processing' (e.g. after a crash).
 *
 * Usage:
 *   const bus = new EventBus('./events.db')
 *   await bus.recover()          // crash recovery — call once at startup
 *   await bus.start()            // start dispatch + watchdog loops
 *
 *   bus.subscribe('agent.message', handler, 'my-handler')
 *   await bus.publish('agent.message', 'telegram', { text: 'hi' })
 *
 *   await bus.stop()             // graceful shutdown
 */

import consola from 'consola'
import { EventJournal } from './journal'
import type { Event, EventHandler } from './models'

export type EventBusOptions = {
  dbPath: string
  pollIntervalMs?: number
  batchSize?: number
  maxRetries?: number
  staleTimeoutMs?: number
  watchdogIntervalMs?: number
}

export class EventBus {
  private readonly journal: EventJournal
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private readonly maxRetries: number
  private readonly staleTimeoutMs: number
  private readonly watchdogIntervalMs: number

  private readonly subscribers = new Map<string, Array<{ handler: EventHandler; id: string }>>()

  private dispatchTimer: Timer | null = null
  private watchdogTimer: Timer | null = null
  private stopped = false

  // Used to wake the dispatch loop immediately on publish()
  private pendingWake = false

  constructor(opts: EventBusOptions) {
    this.journal          = new EventJournal(opts.dbPath)
    this.pollIntervalMs   = opts.pollIntervalMs   ?? 5_000
    this.batchSize        = opts.batchSize        ?? 3
    this.maxRetries       = opts.maxRetries       ?? 3
    this.staleTimeoutMs   = opts.staleTimeoutMs   ?? 300_000
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 30_000
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Publish an event to the journal.
   * Returns the new event id. Fire-and-forget for callers.
   */
  async publish(
    topic: string,
    source: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<number> {
    const id = await this.journal.insert(topic, source, payload, correlationId)
    this.pendingWake = true   // wake the dispatch loop on next tick
    consola.debug(`[EventBus] published topic=${topic} id=${id}`)
    return id
  }

  /** Register an in-memory handler for a topic. Call before start(). */
  subscribe(topic: string, handler: EventHandler, subscriberId: string): void {
    const list = this.subscribers.get(topic) ?? []
    list.push({ handler, id: subscriberId })
    this.subscribers.set(topic, list)
    consola.debug(`[EventBus] subscribed ${subscriberId} → ${topic}`)
  }

  /** Unsubscribe a handler by its subscriber id. */
  unsubscribe(topic: string, subscriberId: string): void {
    const list = this.subscribers.get(topic)
    if (!list) return
    const next = list.filter(s => s.id !== subscriberId)
    if (next.length === 0) {
      this.subscribers.delete(topic)
    } else {
      this.subscribers.set(topic, next)
    }
  }

  /**
   * Crash recovery: reset 'processing' → 'pending'.
   * Must be called once at startup before start().
   */
  async recover(): Promise<number> {
    const count = await this.journal.resetProcessingToPending()
    if (count) consola.info(`[EventBus] recovered ${count} stale events`)
    return count
  }

  /** Start the dispatch loop and watchdog. */
  async start(): Promise<void> {
    this.stopped = false
    this._scheduleDispatch(0)
    this._scheduleWatchdog()
    consola.info('[EventBus] started')
  }

  /** Graceful shutdown: stop accepting new dispatches, drain in-progress. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.dispatchTimer)  { clearTimeout(this.dispatchTimer);  this.dispatchTimer  = null }
    if (this.watchdogTimer)  { clearTimeout(this.watchdogTimer);  this.watchdogTimer  = null }
    await this.journal.close()
    consola.info('[EventBus] stopped')
  }

  // ---------------------------------------------------------------------------
  // Dispatch loop (timer-based, no worker threads needed)
  // ---------------------------------------------------------------------------

  private _scheduleDispatch(delayMs = this.pollIntervalMs): void {
    if (this.stopped) return
    this.dispatchTimer = setTimeout(async () => {
      if (this.stopped) return
      try {
        await this._claimAndDeliverBatch()
      } catch (err) {
        consola.error('[EventBus] dispatch error:', err)
      }
      this._scheduleDispatch(this.pendingWake ? 0 : this.pollIntervalMs)
      this.pendingWake = false
    }, delayMs)
  }

  private async _claimAndDeliverBatch(): Promise<void> {
    const events = await this.journal.claimPending(this.batchSize)
    for (const event of events) {
      if (this.stopped) break
      await this._deliver(event)
    }
  }

  private async _deliver(event: Event): Promise<void> {
    const subs = this.subscribers.get(event.topic)
    if (!subs || subs.length === 0) {
      await this.journal.markDone(event.id)
      return
    }

    const errors: string[] = []
    for (const { handler, id: subId } of subs) {
      try {
        await handler(event)
      } catch (err) {
        const msg = String(err)
        errors.push(msg)
        consola.error(`[EventBus] handler ${subId} failed for event ${event.id}/${event.topic}:`, err)
      }
    }

    if (errors.length === 0) {
      await this.journal.markDone(event.id)
    } else if (event.retryCount < this.maxRetries) {
      await this.journal.markRetry(event.id)
      consola.warn(
        `[EventBus] retrying event ${event.id} (attempt ${event.retryCount + 1}/${this.maxRetries})`
      )
    } else {
      await this.journal.markDeadLetter(event.id, errors.join('; '))
      consola.error(`[EventBus] dead-lettered event ${event.id} after ${event.retryCount} retries`)
    }
  }

  // ---------------------------------------------------------------------------
  // Watchdog
  // ---------------------------------------------------------------------------

  private _scheduleWatchdog(): void {
    if (this.stopped) return
    this.watchdogTimer = setTimeout(async () => {
      if (this.stopped) return
      try {
        const [reset, dead] = await this.journal.recoverStale(this.staleTimeoutMs, this.maxRetries)
        if (reset || dead) {
          consola.info(`[EventBus] watchdog: reset=${reset} dead=${dead}`)
          if (reset) this.pendingWake = true
        }
      } catch (err) {
        consola.error('[EventBus] watchdog error:', err)
      }
      this._scheduleWatchdog()
    }, this.watchdogIntervalMs)
  }
}
