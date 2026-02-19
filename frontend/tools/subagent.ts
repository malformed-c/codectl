import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler, Orchestrator, OrchestratorConfig } from '../orchestrator'

export const SubagentTool: ToolDefinition = {
  name: 'subagent',
  description: 'Spawn a subagent to handle a specific subtask. Returns the final result or last message from the subagent.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The goal or task for the subagent to accomplish.' },
    },
    required: ['goal'],
  },
}

/**
 * Factory for subagent handler.
 * It needs a reference to the Orchestrator class to avoid circular imports if defined inside orchestrator.ts
 * But here we are in a separate file, so we can just take the current config.
 */
export function createSubagentHandler(
  OrchestratorClass: typeof Orchestrator,
  currentConfig: OrchestratorConfig
): ToolHandler {
  return async (args) => {
    const goal = args.goal as string
    const depth = (currentConfig.depth ?? 0) + 1
    const maxDepth = currentConfig.maxDepth ?? 3

    if (depth > maxDepth) {
      return { result: null, error: `Max subagent depth reached (${maxDepth})` }
    }

    const subagent = new OrchestratorClass({
      ...currentConfig,
      depth,
    })

    try {
      const result = await subagent.chat(goal)
      return { result: { content: result.turn.content, toolsExecuted: result.toolsExecuted.length } }

    } catch (err) {
      return { result: null, error: `Subagent failed: ${err}` }
    }
  }
}
