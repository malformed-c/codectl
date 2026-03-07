import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
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

type MemoryStore = {
  set(key: string, value: string): void
  get(key: string): string | undefined
  append(key: string, value: string): boolean
  list(): string[]
  delete(key: string): boolean
  keys(): IterableIterator<string>
}

export function createMemoryHandler(memory: MemoryStore): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const key = args.key as string | undefined
    const content = args.content as string | undefined

    switch (action) {
      case 'set':
        if (!key) return err('Key is required for set action')
        memory.set(key, content ?? '')
        return ok({ success: true, key })

      case 'get':
        if (!key) return err('Key is required for get action')
        return ok({ content: memory.get(key) ?? null })

      case 'append':
        if (!key) return err('Key is required for append action')
        memory.append(key, content ?? '')
        return ok({ success: true, key, totalLength: (memory.get(key) ?? '').length })

      case 'list':
        return ok({ keys: Array.from(memory.keys()) })

      case 'delete':
        if (!key) return err('Key is required for delete action')
        const deleted = memory.delete(key)
        return ok({ success: deleted })

      default:
        return err(`Unknown memory action: ${action}`)
    }
  }
}
