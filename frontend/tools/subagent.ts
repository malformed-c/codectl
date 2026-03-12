import type { Orchestrator, OrchestratorConfig, ToolHandler } from '../orchestrator'
import { turnContent } from '../template'
import type { ToolDefinition } from '../tool'
import { err, ok } from '../tool'
import type { AskChannel } from './ask'

export const SubagentTool: ToolDefinition = {
  name: 'subagent',
  description:
    'Spawn a subagent to handle a specific subtask autonomously. ' +
    'The subagent runs its own agent loop and returns the final result. ' +
    'ask/message from the subagent communicate back to this orchestrator.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The goal or task for the subagent to accomplish.',
      },
      system_prompt: {
        type: 'string',
        description: 'Optional system prompt override for the subagent.',
      },
    },
    required: ['goal'],
  },
}

/**
 * Factory for subagent handler.
 *
 * Config resolution order (later wins):
 *   parentConfig → parentConfig.subagentConfig → per-call overrides from args
 *
 * ask/message from the subagent are routed to the parent:
 *   - ask  → parentAskChannel (same channel the parent door is listening to)
 *   - message → onParentMessage callback → parent FSM onSystem injection
 */
export function createSubagentHandler(
  OrchestratorClass: typeof Orchestrator,
  parentConfig: OrchestratorConfig,
  parentAskChannel: AskChannel,
  onParentMessage?: (content: string) => void,
): ToolHandler {
  return async (args) => {
    const goal = args.goal as string
    const systemPromptOverride = args.system_prompt as string | undefined

    const depth = (parentConfig.depth ?? 0) + 1
    const maxDepth = parentConfig.maxDepth ?? 3

    if (depth > maxDepth) {
      return err(`Max subagent depth reached (${maxDepth})`)
    }

    // Merge: parent → subagentConfig overrides → per-call overrides
    const subagentConfig: OrchestratorConfig = {
      ...parentConfig,
      ...(parentConfig.subagentConfig ?? {}),
      ...(systemPromptOverride ? { systemPrompt: systemPromptOverride } : {}),
      depth,
      parentAskChannel,
      onParentMessage,
    }

    const subagent = new OrchestratorClass(subagentConfig)

    try {
      const result = await subagent.complete(goal)

      return ok({ content: turnContent(result.turn), toolsExecuted: result.toolsExecuted.length })

    }
    catch (e) {
      return err(`Subagent failed: ${e}`)
    }

  }
}
