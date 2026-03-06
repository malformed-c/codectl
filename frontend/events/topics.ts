/**
 * Well-known event bus topic names.
 *
 * Use these constants instead of raw strings to prevent typos and make
 * topic discovery grep-friendly.
 */

export const Topics = {
  // User ↔ channel
  USER_MESSAGE:   'user.message',
  AGENT_REPLY:    'agent.reply',
  AGENT_STREAM:   'agent.stream',

  // Agent lifecycle
  AGENT_STARTED:  'agent.started',
  AGENT_DONE:     'agent.done',
  AGENT_ERROR:    'agent.error',

  // Task engine
  TASK_CREATED:   'task.created',
  TASK_PENDING:   'task.pending',
  TASK_DONE:      'task.done',
  TASK_FAILED:    'task.failed',
  TASK_CANCELLED: 'task.cancelled',

  // System
  HEALTH_CHECK:   'system.health_check',
} as const

export type Topic = (typeof Topics)[keyof typeof Topics]
