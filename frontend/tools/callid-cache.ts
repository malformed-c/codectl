import type { ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'

/**
 * In-memory call-ID cache shared within one Orchestrator session.
 * The model can store any string-serialisable value under an arbitrary key
 * and retrieve it later - useful for avoiding repeated expensive tool calls.
 */
export function createCallIdCacheHandler(cache: Map<string, string>): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const id = args.id as string | undefined
    const value = args.value as string | undefined

    switch (action) {
      case 'set': {
        if (!id) return { result: null, error: "'id' is required for 'set'" }

        if (value === undefined) return { result: null, error: "'value' is required for 'set'" }

        cache.set(id, value)

        return { result: { success: `Stored under key '${id}'` } }
      }

      case 'get': {
        if (!id) return { result: null, error: "'id' is required for 'get'" }

        const stored = cache.get(id)
        if (stored === undefined) return { result: null, error: `No entry for key '${id}'` }

        return { result: { value: stored } }
      }

      case 'delete': {
        if (!id) return { result: null, error: "'id' is required for 'delete'" }

        const existed = cache.delete(id)
        return { result: { success: existed ? `Deleted '${id}'` : `Key '${id}' not found` } }
      }

      case 'list': {
        const keys = Array.from(cache.keys())
        return { result: { keys: keys.length ? keys.join(', ') : '(empty)' } }
      }

      default:
        return { result: null, error: `Unknown cache action: ${action}` }
    }
  }
}
