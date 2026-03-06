/**
 * Task chain types.
 *
 * A Task is a unit of work the agent can create, track, and chain.
 * Tasks can depend on each other via afterTaskId: a task stays 'blocked'
 * until its predecessor is 'done', then transitions to 'pending'.
 *
 * Chain semantics (ported from yodoca/sandbox/extensions/task_engine/):
 *   - done predecessor   → successor becomes pending; predecessor result injected into payload
 *   - failed predecessor → cascade failure to all downstream blocked tasks
 *   - cancelled          → cascade cancellation downstream
 */

export type TaskStatus = 'pending' | 'blocked' | 'running' | 'done' | 'failed' | 'cancelled'

export type Task = {
  taskId: string
  /** Which agent/tool should handle this task. */
  agentId?: string
  status: TaskStatus
  goal: string
  payload: Record<string, unknown>
  /** Block this task until afterTaskId is done. */
  afterTaskId?: string
  /** Group identifier for related tasks. */
  chainId?: string
  /** Ordering hint within a chain (lower = earlier). */
  chainOrder?: number
  result?: unknown
  error?: string
  createdAt: number   // unix ms
  updatedAt: number   // unix ms
}

export type CreateTaskOpts = {
  taskId?: string
  agentId?: string
  goal: string
  payload?: Record<string, unknown>
  afterTaskId?: string
  chainId?: string
  chainOrder?: number
}

export type CompleteTaskOpts = {
  taskId: string
  result?: unknown
}

export type FailTaskOpts = {
  taskId: string
  error: string
}
