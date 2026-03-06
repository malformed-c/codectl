import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskEngine } from '../plan/engine'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string
let engine: TaskEngine

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codectl-tasks-'))
  engine = new TaskEngine(join(tmpDir, 'tasks.db'))
})

afterEach(async () => {
  engine.close()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe('TaskEngine - basic CRUD', () => {
  test('create returns task with generated id and pending status', async () => {
    const task = await engine.create({ goal: 'do something' })
    expect(task.taskId).toBeTruthy()
    expect(task.status).toBe('pending')
    expect(task.goal).toBe('do something')
  })

  test('create with afterTaskId starts as blocked', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
    expect(t2.status).toBe('blocked')
    expect(t2.afterTaskId).toBe(t1.taskId)
  })

  test('get returns null for missing task', () => {
    expect(engine.get('no-such-id')).toBeNull()
  })

  test('get returns task after create', async () => {
    const created = await engine.create({ goal: 'g' })
    const fetched = engine.get(created.taskId)
    expect(fetched!.taskId).toBe(created.taskId)
    expect(fetched!.goal).toBe('g')
  })

  test('start transitions pending to running', async () => {
    const t = await engine.create({ goal: 'g' })
    await engine.start(t.taskId)
    expect(engine.get(t.taskId)!.status).toBe('running')
  })

  test('listPending excludes blocked and running tasks', async () => {
    const t1 = await engine.create({ goal: 'pending' })
    const t2 = await engine.create({ goal: 'blocked', afterTaskId: t1.taskId })
    await engine.start(t1.taskId)

    const pending = engine.listPending()
    const ids = pending.map(t => t.taskId)
    expect(ids).not.toContain(t1.taskId)  // running
    expect(ids).not.toContain(t2.taskId)  // blocked
  })

  test('payload is stored and retrieved', async () => {
    const t = await engine.create({ goal: 'g', payload: { key: 'value', n: 42 } })
    expect(engine.get(t.taskId)!.payload).toEqual({ key: 'value', n: 42 })
  })

  test('chainId and chainOrder are stored', async () => {
    const t = await engine.create({ goal: 'g', chainId: 'chain-1', chainOrder: 3 })
    const fetched = engine.get(t.taskId)!
    expect(fetched.chainId).toBe('chain-1')
    expect(fetched.chainOrder).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Completion and successor unblocking
// ---------------------------------------------------------------------------

describe('TaskEngine - completion and unblocking', () => {
  test('completing a task unblocks its direct successor', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })

    await engine.complete({ taskId: t1.taskId, result: 'result-1' })

    expect(engine.get(t1.taskId)!.status).toBe('done')
    expect(engine.get(t2.taskId)!.status).toBe('pending')
  })

  test('predecessor result is injected into successor payload', async () => {
    const t1 = await engine.create({ goal: 'compute' })
    const t2 = await engine.create({ goal: 'use result', afterTaskId: t1.taskId })

    await engine.complete({ taskId: t1.taskId, result: 'computed-value' })

    const t2After = engine.get(t2.taskId)!
    expect(t2After.payload.predecessorResult).toBe('computed-value')
    expect(t2After.payload.predecessorTaskId).toBe(t1.taskId)
  })

  test('complete with object result serialises into successor payload', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })

    await engine.complete({ taskId: t1.taskId, result: { files: ['a.ts', 'b.ts'] } })

    const payload = engine.get(t2.taskId)!.payload
    expect(payload.predecessorResult).toContain('a.ts')
  })

  test('completing without result still unblocks successor', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })

    await engine.complete({ taskId: t1.taskId })

    expect(engine.get(t2.taskId)!.status).toBe('pending')
  })

  test('chain of 3 unblocks step by step', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
    const t3 = await engine.create({ goal: 'step 3', afterTaskId: t2.taskId })

    // Initially only t1 is pending
    expect(engine.get(t2.taskId)!.status).toBe('blocked')
    expect(engine.get(t3.taskId)!.status).toBe('blocked')

    await engine.complete({ taskId: t1.taskId })
    expect(engine.get(t2.taskId)!.status).toBe('pending')
    expect(engine.get(t3.taskId)!.status).toBe('blocked')  // still waiting on t2

    await engine.complete({ taskId: t2.taskId, result: 'mid-result' })
    expect(engine.get(t3.taskId)!.status).toBe('pending')
    expect(engine.get(t3.taskId)!.payload.predecessorResult).toBe('mid-result')
  })

  test('result is stored on the completed task', async () => {
    const t = await engine.create({ goal: 'g' })
    await engine.complete({ taskId: t.taskId, result: { answer: 42 } })
    expect(engine.get(t.taskId)!.result).toEqual({ answer: 42 })
  })
})

// ---------------------------------------------------------------------------
// Failure cascade
// ---------------------------------------------------------------------------

describe('TaskEngine - failure cascade', () => {
  test('failing a task cascades to direct blocked successor', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })

    await engine.fail({ taskId: t1.taskId, error: 'network error' })

    expect(engine.get(t1.taskId)!.status).toBe('failed')
    expect(engine.get(t2.taskId)!.status).toBe('failed')
    expect(engine.get(t2.taskId)!.error).toContain(t1.taskId)
  })

  test('failure cascades transitively through a chain', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
    const t3 = await engine.create({ goal: 'step 3', afterTaskId: t2.taskId })
    const t4 = await engine.create({ goal: 'step 4', afterTaskId: t3.taskId })

    await engine.fail({ taskId: t1.taskId, error: 'root cause' })

    expect(engine.get(t2.taskId)!.status).toBe('failed')
    expect(engine.get(t3.taskId)!.status).toBe('failed')
    expect(engine.get(t4.taskId)!.status).toBe('failed')
  })

  test('error message is stored on failed task', async () => {
    const t = await engine.create({ goal: 'g' })
    await engine.fail({ taskId: t.taskId, error: 'something went wrong' })
    expect(engine.get(t.taskId)!.error).toBe('something went wrong')
  })

  test('failure does not affect already-done tasks', async () => {
    // t1 -> t2 (parallel) and t1 -> t3 (blocked)
    // completing t2 then failing t1 should not touch t2
    const t1 = await engine.create({ goal: 'root' })
    const t2 = await engine.create({ goal: 'parallel', afterTaskId: t1.taskId })
    const t3 = await engine.create({ goal: 'other', afterTaskId: t1.taskId })

    await engine.complete({ taskId: t1.taskId })
    await engine.complete({ taskId: t2.taskId })
    // t3 is now pending; failing t2 should not cascade (t3 doesn't depend on t2)
    await engine.fail({ taskId: t2.taskId, error: 'oops' })

    expect(engine.get(t3.taskId)!.status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('TaskEngine - cancellation', () => {
  test('cancel transitions task to cancelled', async () => {
    const t = await engine.create({ goal: 'g' })
    await engine.cancel(t.taskId, 'user cancelled')
    expect(engine.get(t.taskId)!.status).toBe('cancelled')
  })

  test('cancel cascades to downstream blocked tasks', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
    const t3 = await engine.create({ goal: 'step 3', afterTaskId: t2.taskId })

    await engine.cancel(t1.taskId, 'stopped')

    expect(engine.get(t2.taskId)!.status).toBe('cancelled')
    expect(engine.get(t3.taskId)!.status).toBe('cancelled')
  })

  test('cancel does not affect done tasks', async () => {
    const t1 = await engine.create({ goal: 'step 1' })
    const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
    await engine.complete({ taskId: t1.taskId })
    await engine.complete({ taskId: t2.taskId })

    await engine.cancel(t1.taskId)  // already done, should be no-op

    expect(engine.get(t1.taskId)!.status).toBe('done')
    expect(engine.get(t2.taskId)!.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// List and chain queries
// ---------------------------------------------------------------------------

describe('TaskEngine - list and chain queries', () => {
  test('listByChain returns tasks ordered by chainOrder', async () => {
    const chainId = 'my-chain'
    await engine.create({ goal: 'c', chainId, chainOrder: 3 })
    await engine.create({ goal: 'a', chainId, chainOrder: 1 })
    await engine.create({ goal: 'b', chainId, chainOrder: 2 })

    const tasks = engine.listByChain(chainId)
    expect(tasks.map(t => t.goal)).toEqual(['a', 'b', 'c'])
  })

  test('listByChain returns empty array for unknown chain', () => {
    expect(engine.listByChain('no-such-chain')).toHaveLength(0)
  })

  test('listAll returns most recent first up to limit', async () => {
    for (let i = 0; i < 5; i++) await engine.create({ goal: `task-${i}` })
    const all = engine.listAll(3)
    expect(all).toHaveLength(3)
  })

  test('listPending filters by agentId', async () => {
    await engine.create({ goal: 'for agent-a', agentId: 'agent-a' })
    await engine.create({ goal: 'for agent-b', agentId: 'agent-b' })

    const forA = engine.listPending('agent-a')
    expect(forA).toHaveLength(1)
    expect(forA[0]!.goal).toBe('for agent-a')
  })
})
