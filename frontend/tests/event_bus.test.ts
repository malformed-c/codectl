import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventJournal } from '../events/journal'
import { EventBus } from '../events/bus'
import type { Event } from '../events/models'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

async function makeJournal(): Promise<EventJournal> {
  return new EventJournal(join(tmpDir, `journal-${Math.random()}.db`))
}

async function makeBus(opts: { pollIntervalMs?: number } = {}): Promise<EventBus> {
  return new EventBus({
    dbPath: join(tmpDir, `bus-${Math.random()}.db`),
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    batchSize: 5,
    maxRetries: 2,
    staleTimeoutMs: 60_000,
    watchdogIntervalMs: 999_999, // disable watchdog in tests
  })
}

function waitMs(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codectl-events-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// EventJournal
// ---------------------------------------------------------------------------

describe('EventJournal', () => {
  test('insert and claim pending', async () => {
    const journal = await makeJournal()
    const id = await journal.insert('test.topic', 'src', { foo: 1 })
    expect(id).toBeGreaterThan(0)

    const events = await journal.claimPending(10)
    expect(events).toHaveLength(1)
    expect(events[0]!.topic).toBe('test.topic')
    expect(events[0]!.source).toBe('src')
    expect(events[0]!.payload).toEqual({ foo: 1 })
    expect(events[0]!.status).toBe('processing')

    // Already claimed — should not appear again
    const second = await journal.claimPending(10)
    expect(second).toHaveLength(0)

    await journal.close()
  })

  test('markDone removes from pending', async () => {
    const journal = await makeJournal()
    const id = await journal.insert('t', 's', {})
    const events = await journal.claimPending(1)
    await journal.markDone(events[0]!.id)

    const after = await journal.claimPending(10)
    expect(after).toHaveLength(0)

    await journal.close()
  })

  test('markRetry re-queues with incremented retry_count', async () => {
    const journal = await makeJournal()
    await journal.insert('t', 's', {})
    const [ev] = await journal.claimPending(1)
    expect(ev!.retryCount).toBe(0)

    await journal.markRetry(ev!.id)

    const [retried] = await journal.claimPending(1)
    expect(retried!.retryCount).toBe(1)

    await journal.close()
  })

  test('markDeadLetter removes from pending permanently', async () => {
    const journal = await makeJournal()
    await journal.insert('t', 's', {})
    const [ev] = await journal.claimPending(1)
    await journal.markDeadLetter(ev!.id, 'too many errors')

    const after = await journal.claimPending(10)
    expect(after).toHaveLength(0)

    await journal.close()
  })

  test('resetProcessingToPending restores stuck events', async () => {
    const journal = await makeJournal()
    await journal.insert('t', 's', {})
    await journal.claimPending(1)  // now 'processing'

    const count = await journal.resetProcessingToPending()
    expect(count).toBe(1)

    const reclaimed = await journal.claimPending(1)
    expect(reclaimed).toHaveLength(1)

    await journal.close()
  })

  test('correlationId is stored and returned', async () => {
    const journal = await makeJournal()
    await journal.insert('t', 's', {}, 'corr-123')
    const [ev] = await journal.claimPending(1)
    expect(ev!.correlationId).toBe('corr-123')

    await journal.close()
  })

  test('claimPending respects limit', async () => {
    const journal = await makeJournal()
    for (let i = 0; i < 5; i++) await journal.insert('t', 's', { i })

    const batch = await journal.claimPending(3)
    expect(batch).toHaveLength(3)

    await journal.close()
  })

  test('recoverStale resets or dead-letters based on retryCount', async () => {
    const journal = await makeJournal()

    // Insert two events
    await journal.insert('t', 's', {})
    await journal.insert('t', 's', {})

    const events = await journal.claimPending(2)
    // Make the second one exceed maxRetries via markRetry twice
    await journal.markRetry(events[1]!.id)
    await journal.markRetry(events[1]!.id)

    // Re-claim to have them back in processing for the watchdog
    const [stuck1] = await journal.claimPending(1)

    // Hack: set created_at far in the past to simulate stale
    // (We use a very short staleMs so current timestamps are already "stale")
    const [reset, dead] = await journal.recoverStale(0, 2)
    expect(reset + dead).toBeGreaterThan(0)

    await journal.close()
  })
})

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

describe('EventBus', () => {
  test('subscribe and receive event', async () => {
    const bus = await makeBus()
    await bus.recover()
    await bus.start()

    const received: Event[] = []
    bus.subscribe('greet', async (ev) => { received.push(ev) }, 'test-handler')

    await bus.publish('greet', 'test', { msg: 'hello' })

    // Give dispatch loop time to run
    await waitMs(100)
    await bus.stop()

    expect(received).toHaveLength(1)
    expect(received[0]!.payload).toEqual({ msg: 'hello' })
    expect(received[0]!.topic).toBe('greet')
  })

  test('events without subscribers are silently marked done', async () => {
    const bus = await makeBus()
    await bus.recover()
    await bus.start()

    // No subscriber registered for this topic
    await bus.publish('orphan.topic', 'test', { x: 1 })
    await waitMs(100)
    await bus.stop()
    // No error thrown — that's the assertion
  })

  test('failing handler triggers retry then dead-letter', async () => {
    const bus = await makeBus({ pollIntervalMs: 10 })
    await bus.recover()
    await bus.start()

    let attempts = 0
    bus.subscribe('flaky', async () => {
      attempts++
      throw new Error('handler blew up')
    }, 'flaky-handler')

    await bus.publish('flaky', 'test', {})

    // maxRetries=2 means 3 total attempts (0,1,2 retryCount)
    await waitMs(300)
    await bus.stop()

    expect(attempts).toBe(3)
  })

  test('multiple subscribers on same topic both receive event', async () => {
    const bus = await makeBus()
    await bus.recover()
    await bus.start()

    const aReceived: Event[] = []
    const bReceived: Event[] = []
    bus.subscribe('shared', async (ev) => { aReceived.push(ev) }, 'sub-a')
    bus.subscribe('shared', async (ev) => { bReceived.push(ev) }, 'sub-b')

    await bus.publish('shared', 'src', { data: 42 })
    await waitMs(100)
    await bus.stop()

    expect(aReceived).toHaveLength(1)
    expect(bReceived).toHaveLength(1)
  })

  test('unsubscribe stops delivery', async () => {
    const bus = await makeBus()
    await bus.recover()
    await bus.start()

    const received: Event[] = []
    bus.subscribe('evt', async (ev) => { received.push(ev) }, 'removable')
    bus.unsubscribe('evt', 'removable')

    await bus.publish('evt', 'src', {})
    await waitMs(100)
    await bus.stop()

    expect(received).toHaveLength(0)
  })

  test('recover() at startup picks up events from previous crash', async () => {
    const dbPath = join(tmpDir, 'crash-recovery.db')

    // Simulate a crash: publish but never deliver
    const journal = new EventJournal(dbPath)
    const id = await journal.insert('crash.topic', 'src', { payload: 'lost' })
    await journal.claimPending(1)  // stuck in 'processing'
    await journal.close()

    // New bus instance, same db
    const bus = new EventBus({ dbPath, pollIntervalMs: 20, batchSize: 5, maxRetries: 2 })

    const received: Event[] = []
    bus.subscribe('crash.topic', async (ev) => { received.push(ev) }, 'recovery-handler')

    await bus.recover()  // resets 'processing' → 'pending'
    await bus.start()
    await waitMs(100)
    await bus.stop()

    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(id)
  })

  test('publish returns unique incrementing ids', async () => {
    const bus = await makeBus()
    await bus.recover()
    await bus.start()

    const id1 = await bus.publish('t', 's', {})
    const id2 = await bus.publish('t', 's', {})
    await bus.stop()

    expect(id2).toBeGreaterThan(id1)
  })
})
