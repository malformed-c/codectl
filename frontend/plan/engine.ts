/**
 * TaskEngine: persistent task queue with chain dependency support.
 *
 * Ported from yodoca/sandbox/extensions/task_engine/ (chains.py, state.py).
 *
 * Features:
 *   - SQLite persistence (bun:sqlite)
 *   - Successor unblocking: when a task completes, its predecessor result is
 *     injected into successor payloads and they transition pending → runnable
 *   - Cascade failure: failed/cancelled tasks propagate downstream
 *   - Chain queries: list all tasks in a chain ordered by chainOrder
 *
 * Usage:
 *   const engine = new TaskEngine('./tasks.db')
 *   const t1 = await engine.create({ goal: 'step 1' })
 *   const t2 = await engine.create({ goal: 'step 2', afterTaskId: t1.taskId })
 *   await engine.complete({ taskId: t1.taskId, result: 'done!' })
 *   // t2 is now pending with payload.predecessorResult = 'done!'
 */

import { Database } from 'bun:sqlite'
import consola from 'consola'
import { randomUUIDv7 } from 'bun'
import type { Task, TaskStatus, CreateTaskOpts, CompleteTaskOpts, FailTaskOpts } from './task'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_task (
  task_id       TEXT    PRIMARY KEY,
  agent_id      TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  goal          TEXT    NOT NULL,
  payload       TEXT    NOT NULL DEFAULT '{}',
  after_task_id TEXT,
  chain_id      TEXT,
  chain_order   INTEGER,
  result        TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status       ON agent_task(status);
CREATE INDEX IF NOT EXISTS idx_task_chain        ON agent_task(chain_id);
CREATE INDEX IF NOT EXISTS idx_task_after        ON agent_task(after_task_id);
`

export class TaskEngine {
  private readonly db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  async create(opts: CreateTaskOpts): Promise<Task> {
    const now = Date.now()
    const taskId = opts.taskId ?? randomUUIDv7()
    const status: TaskStatus = opts.afterTaskId ? 'blocked' : 'pending'

    this.db.prepare(`
      INSERT INTO agent_task
        (task_id, agent_id, status, goal, payload, after_task_id, chain_id, chain_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      opts.agentId ?? null,
      status,
      opts.goal,
      JSON.stringify(opts.payload ?? {}),
      opts.afterTaskId ?? null,
      opts.chainId ?? null,
      opts.chainOrder ?? null,
      now,
      now,
    )

    consola.debug(`[TaskEngine] created ${taskId} status=${status}`)
    return this.get(taskId)!
  }

  async start(taskId: string): Promise<void> {
    this._updateStatus(taskId, 'running')
  }

  /**
   * Mark a task done and unblock its successors.
   * Predecessor result is injected into each successor's payload.
   */
  async complete(opts: CompleteTaskOpts): Promise<void> {
    const now = Date.now()
    this.db.prepare(`
      UPDATE agent_task SET status = 'done', result = ?, updated_at = ?
      WHERE  task_id = ?
    `).run(
      opts.result !== undefined ? JSON.stringify(opts.result) : null,
      now,
      opts.taskId,
    )
    consola.debug(`[TaskEngine] completed ${opts.taskId}`)
    await this._unblockSuccessors(opts.taskId, 'done', opts.result)
  }

  async fail(opts: FailTaskOpts): Promise<void> {
    const now = Date.now()
    this.db.prepare(`
      UPDATE agent_task SET status = 'failed', error = ?, updated_at = ?
      WHERE  task_id = ?
    `).run(opts.error, now, opts.taskId)
    consola.warn(`[TaskEngine] failed ${opts.taskId}: ${opts.error}`)
    await this._unblockSuccessors(opts.taskId, 'failed')
  }

  async cancel(taskId: string, reason = ''): Promise<void> {
    const now = Date.now()
    this.db.prepare(`
      UPDATE agent_task SET status = 'cancelled', error = ?, updated_at = ?
      WHERE  task_id = ? AND status NOT IN ('done', 'failed')
    `).run(reason || 'Cancelled', now, taskId)
    await this._cancelDownstream(taskId, reason)
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  get(taskId: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM agent_task WHERE task_id = ?`).get(taskId) as any
    return row ? this._rowToTask(row) : null
  }

  listPending(agentId?: string): Task[] {
    const rows = agentId
      ? this.db.prepare(`SELECT * FROM agent_task WHERE status = 'pending' AND agent_id = ? ORDER BY created_at ASC`).all(agentId)
      : this.db.prepare(`SELECT * FROM agent_task WHERE status = 'pending' ORDER BY created_at ASC`).all()
    return (rows as any[]).map(this._rowToTask)
  }

  listByChain(chainId: string): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_task
      WHERE  chain_id = ?
      ORDER  BY chain_order ASC NULLS LAST, created_at ASC
    `).all(chainId) as any[]
    return rows.map(this._rowToTask)
  }

  listAll(limit = 50): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_task ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[]
    return rows.map(this._rowToTask)
  }

  // ---------------------------------------------------------------------------
  // Chain logic (ported from yodoca chains.py)
  // ---------------------------------------------------------------------------

  /**
   * When a task completes:
   *   - done → inject predecessor result into successors, unblock them
   *   - failed/cancelled → cascade failure to all downstream blocked tasks
   */
  private async _unblockSuccessors(
    completedTaskId: string,
    status: 'done' | 'failed' | 'cancelled',
    result?: unknown,
  ): Promise<void> {
    const rows = this.db.prepare(`
      SELECT task_id, payload FROM agent_task
      WHERE  after_task_id = ? AND status = 'blocked'
    `).all(completedTaskId) as any[]

    if (status === 'done') {
      const predecessorContent =
        result !== undefined
          ? (typeof result === 'object' ? JSON.stringify(result) : String(result))
          : ''

      for (const row of rows) {
        const payload = { ...(JSON.parse(row.payload) as Record<string, unknown>) }
        payload.predecessorResult = predecessorContent
        payload.predecessorTaskId = completedTaskId

        this.db.prepare(`
          UPDATE agent_task SET payload = ?, status = 'pending', updated_at = ?
          WHERE  task_id = ?
        `).run(JSON.stringify(payload), Date.now(), row.task_id)

        consola.info(`[TaskEngine] unblocked ${row.task_id} (predecessor ${completedTaskId} done)`)
      }
    } else {
      // Cascade failure/cancellation
      for (const row of rows) {
        const errMsg = `Predecessor ${completedTaskId} ${status}`
        this.db.prepare(`
          UPDATE agent_task SET status = 'failed', error = ?, updated_at = ?
          WHERE  task_id = ? AND status = 'blocked'
        `).run(errMsg, Date.now(), row.task_id)

        // Recurse downstream
        await this._unblockSuccessors(row.task_id, 'failed')
      }

      if (rows.length) {
        consola.info(
          `[TaskEngine] cascaded ${status} from ${completedTaskId} to ${rows.length} successor(s)`
        )
      }
    }
  }

  /** Cancel all blocked tasks transitively downstream of taskId. */
  private async _cancelDownstream(taskId: string, reason: string): Promise<number> {
    const errMsg = reason || 'Cancelled (predecessor cancelled)'
    let total = 0
    let currentIds = [taskId]

    while (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT task_id FROM agent_task
        WHERE  after_task_id IN (${placeholders}) AND status = 'blocked'
      `).all(...currentIds) as any[]

      const nextIds = rows.map(r => r.task_id)
      for (const id of nextIds) {
        this.db.prepare(`
          UPDATE agent_task SET status = 'cancelled', error = ?, updated_at = ?
          WHERE task_id = ?
        `).run(errMsg, Date.now(), id)
        total++
      }
      currentIds = nextIds
    }

    if (total) {
      consola.info(`[TaskEngine] cancelled ${total} downstream task(s) of ${taskId}`)
    }
    return total
  }

  private _updateStatus(taskId: string, status: TaskStatus): void {
    this.db.prepare(
      `UPDATE agent_task SET status = ?, updated_at = ? WHERE task_id = ?`
    ).run(status, Date.now(), taskId)
  }

  private _rowToTask(row: any): Task {
    return {
      taskId:      row.task_id,
      agentId:     row.agent_id ?? undefined,
      status:      row.status as TaskStatus,
      goal:        row.goal,
      payload:     JSON.parse(row.payload),
      afterTaskId: row.after_task_id ?? undefined,
      chainId:     row.chain_id ?? undefined,
      chainOrder:  row.chain_order ?? undefined,
      result:      row.result ? JSON.parse(row.result) : undefined,
      error:       row.error ?? undefined,
      createdAt:   row.created_at,
      updatedAt:   row.updated_at,
    }
  }

  close(): void {
    this.db.close()
  }
}
