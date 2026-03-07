import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'

// --- Tool definitions ---

export const AskTool: ToolDefinition = {
  name: 'ask',
  description:
    'Only in agent mode. Ask the user a question and wait for their reply before continuing. ' +
    'Use this when you need clarification or a decision that only the user can provide. ' +
    'The agent loop is paused until the user responds.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user.',
      },
    },
    required: ['question'],
  },
  returns: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: "The user's reply." },
    },
  },
}

export const MessageTool: ToolDefinition = {
  name: 'message',
  description:
    'Only in agent mode. Send a message or status update to the user without pausing the agent loop. ' +
    'Use this to report progress, intermediate results, or anything the user should ' +
    'know while you continue working.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The message to send to the user.',
      },
    },
    required: ['content'],
  },
  returns: {
    type: 'object',
    properties: {
      sent: { type: 'boolean' },
    },
  },
}

// --- AskChannel ---

/**
 * Manages a single pending ask from the model.
 *
 * The orchestrator holds one instance of this shared between the ask tool
 * handler and the door. When the model calls `ask`, the handler suspends
 * on waitForReply(). The door calls resolveAsk() when the user responds,
 * which unblocks the handler and lets the agent loop continue.
 *
 * Only one ask can be pending at a time - a second ask call while one is
 * pending will error immediately rather than silently queueing.
 */
export class AskChannel {
  private pending: {
    question: string
    resolve: (answer: string) => void
    reject: (err: Error) => void
  } | null = null

  get hasPending(): boolean {
    return this.pending !== null
  }

  get pendingQuestion(): string | undefined {
    return this.pending?.question
  }

  /**
   * Called by the ask tool handler. Suspends until resolveAsk() is called.
   */
  waitForReply(question: string): Promise<string> {
    if (this.pending) {
      return Promise.reject(
        new Error('Another ask is already pending. Only one ask can be active at a time.')
      )
    }

    return new Promise<string>((resolve, reject) => {
      this.pending = { question, resolve, reject }
    })
  }

  /**
   * Called by the door when the user sends a message while an ask is pending.
   * Returns true if there was a pending ask that was resolved, false otherwise.
   */
  resolveAsk(answer: string): boolean {
    if (!this.pending) return false

    const { resolve } = this.pending
    this.pending = null
    resolve(answer)

    return true
  }

  /**
   * Cancel a pending ask with an error (e.g. on session reset or abort).
   */
  abort(reason = 'Ask was cancelled.'): void {
    if (!this.pending) return

    const { reject } = this.pending
    this.pending = null
    reject(new Error(reason))
  }
}

// --- Handlers ---

export function createAskHandler(channel: AskChannel): ToolHandler {
  return async (args): Promise<ToolResult> => {
    const question = args.question as string

    try {
      const answer = await channel.waitForReply(question)

      return ok({ answer})

    } catch (err) {
      return err(String(err))
    }
  }
}

export function createMessageHandler(): ToolHandler {
  return async (_args): Promise<ToolResult> => {
    return ok({ sent: true})
  }
}
