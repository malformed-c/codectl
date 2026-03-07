/**
 * Task tools: agent-facing interface to the TaskEngine.
 *
 * Exposes task_create, task_complete, task_fail, task_cancel, task_list,
 * task_get as orchestrator tools so the agent can manage chained work items.
 *
 * Register all at once:
 *   import { TaskTools, createTaskHandlers } from './tools/task'
 *   const engine = new TaskEngine('./tasks.db')
 *   orchestrator.registerToolSet(TaskTools, createTaskHandlers(engine))
 */

import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'
import { TaskEngine } from '../plan/engine'

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const taskCreateTool: ToolDefinition = {
  name: 'task_create',
  description:
    'Create a new task. If afterTaskId is set the task is blocked until that task completes. ' +
    'Use chainId to group related tasks and chainOrder to control their relative ordering.',
  parameters: {
    type: 'object',
    properties: {
      goal:        { type: 'string',  description: 'What this task should accomplish.' },
      agentId:     { type: 'string',  description: 'Which agent/subagent handles it (optional).' },
      afterTaskId: { type: 'string',  description: 'Block until this task is done (optional).' },
      chainId:     { type: 'string',  description: 'Group identifier for related tasks (optional).' },
      chainOrder:  { type: 'integer', description: 'Ordering hint within chain (optional).' },
      payload:     { type: 'object',  description: 'Extra data for the task (optional).' },
    },
    required: ['goal'],
  },
  returns: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Assigned task ID.' },
      status: { type: 'string', description: 'Initial status (pending or blocked).' },
    },
  },
}

const taskCompleteTool: ToolDefinition = {
  name: 'task_complete',
  description: 'Mark a task as done. Unblocks any tasks that were waiting on it.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task to complete.' },
      result: { type: 'string', description: 'Result value (optional, injected into successor payloads).' },
    },
    required: ['taskId'],
  },
  returns: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
}

const taskFailTool: ToolDefinition = {
  name: 'task_fail',
  description: 'Mark a task as failed. Cascades failure to all downstream blocked tasks.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task to fail.' },
      error:  { type: 'string', description: 'Error message.' },
    },
    required: ['taskId', 'error'],
  },
  returns: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
}

const taskCancelTool: ToolDefinition = {
  name: 'task_cancel',
  description: 'Cancel a task and all downstream blocked tasks.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task to cancel.' },
      reason: { type: 'string', description: 'Reason (optional).' },
    },
    required: ['taskId'],
  },
  returns: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
}

const taskGetTool: ToolDefinition = {
  name: 'task_get',
  description: 'Get the current status and details of a task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task to retrieve.' },
    },
    required: ['taskId'],
  },
}

const taskListTool: ToolDefinition = {
  name: 'task_list',
  description: 'List tasks. Filter by chainId or status.',
  parameters: {
    type: 'object',
    properties: {
      chainId: { type: 'string', description: 'Only tasks in this chain (optional).' },
      status:  {
        type: 'string',
        enum: ['pending', 'blocked', 'running', 'done', 'failed', 'cancelled'],
        description: 'Filter by status (optional).',
      },
      limit:   { type: 'integer', description: 'Max results (default 20).' },
    },
    required: [],
  },
}

export const TaskTools: ToolDefinition[] = [
  taskCreateTool,
  taskCompleteTool,
  taskFailTool,
  taskCancelTool,
  taskGetTool,
  taskListTool,
]

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createTaskHandlers(engine: TaskEngine): Record<string, ToolHandler> {
  return {
    async task_create(args): Promise<ToolResult> {
      const goal = args.goal as string
      if (!goal) return err("'goal' is required")

      const task = await engine.create({
        goal,
        agentId:     args.agentId as string | undefined,
        afterTaskId: args.afterTaskId as string | undefined,
        chainId:     args.chainId as string | undefined,
        chainOrder:  args.chainOrder as number | undefined,
        payload:     (args.payload as Record<string, unknown> | undefined) ?? {},
      })

      return ok({ taskId: task.taskId, status: task.status})
    },

    async task_complete(args): Promise<ToolResult> {
      const taskId = args.taskId as string
      if (!taskId) return err("'taskId' is required")

      await engine.complete({ taskId, result: args.result })
      return ok({ ok: true})
    },

    async task_fail(args): Promise<ToolResult> {
      const taskId = args.taskId as string
      const error  = args.error as string
      if (!taskId || !error) return err("'taskId' and 'error' are required")

      await engine.fail({ taskId, error })
      return ok({ ok: true})
    },

    async task_cancel(args): Promise<ToolResult> {
      const taskId = args.taskId as string
      if (!taskId) return err("'taskId' is required")

      await engine.cancel(taskId, args.reason as string | undefined)
      return ok({ ok: true})
    },

    async task_get(args): Promise<ToolResult> {
      const taskId = args.taskId as string
      if (!taskId) return err("'taskId' is required")

      const task = engine.get(taskId)
      if (!task) return err(`Task ${taskId} not found`)
      return ok(task)
    },

    async task_list(args): Promise<ToolResult> {
      const chainId = args.chainId as string | undefined
      const limit   = (args.limit as number | undefined) ?? 20

      const tasks = chainId
        ? engine.listByChain(chainId)
        : engine.listAll(limit)

      const filtered = args.status
        ? tasks.filter(t => t.status === args.status)
        : tasks

      return ok(filtered.slice(0, limit))
    },
  }
}
