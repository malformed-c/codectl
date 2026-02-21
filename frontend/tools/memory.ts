import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'

export const MemoryTool: ToolDefinition = {
  name: 'memory',
  description: 'Manage short-term memory for the current session. Store values with set, then reference them in any tool argument using $key or ${key} syntax - the orchestrator substitutes the stored value before the tool runs.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'get', 'append', 'list', 'delete'],
        description: 'Action to perform on memory.',
      },
      key: { type: 'string', description: 'Key to store or retrieve.' },
      content: { type: 'string', description: 'Content to store (for set or append).' },
    },
    required: ['action'],
  },
}

// TODO ts-pattern
export function createMemoryHandler(memory: Map<string, string>): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const key = args.key as string | undefined
    const content = args.content as string | undefined

    switch (action) {
      case 'set':
        if (!key) return { result: null, error: 'Key is required for set action' }

        memory.set(key, content ?? '')
        return { result: { success: true, key } }

      case 'get':
        if (!key) return { result: null, error: 'Key is required for get action' }

        return { result: { content: memory.get(key) ?? null } }

      case 'append':
        if (!key) return { result: null, error: 'Key is required for append action' }

        const existing = memory.get(key) ?? ''
        const updated = existing + (content ?? '')
        memory.set(key, updated)

        return { result: { success: true, key, totalLength: updated.length } }

      case 'list':
        return { result: { keys: Array.from(memory.keys()) } }

      case 'delete':
        if (!key) return { result: null, error: 'Key is required for delete action' }

        const deleted = memory.delete(key)
        return { result: { success: deleted } }

      default:
        return { result: null, error: `Unknown memory action: ${action}` }
    }
  }
}
