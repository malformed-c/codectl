import type { ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'

/**
 * In-memory call-ID cache shared within one Orchestrator session.
 * The model can store any string-serialisable value under an arbitrary key
 * and retrieve it later - useful for avoiding repeated expensive tool calls.
 */
export function createCallIdCacheHandler(cache: Map<string, string>): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const rawId = args.id as string | undefined
    const id = rawId?.startsWith('$') ? rawId.slice(1) : rawId
    const value = args.value as string | undefined

    switch (action) {
      case 'set': {
        if (!id) return err("'id' is required for 'set'")

        if (value === undefined) return err("'value' is required for 'set'")

        cache.set(id, value)

        return ok({ success: `Stored under key '${id}'` })
      }

      case 'get': {
        if (!id) return err("'id' is required for 'get'")

        const stored = cache.get(id)
        if (stored === undefined) return err(`No entry for key '${id}'. Use call_cache(set, ${id}, <value>) to store it first.`)

        return ok({ value: stored})
      }

      case 'delete': {
        if (!id) return err("'id' is required for 'delete'")

        const existed = cache.delete(id)
        return ok({ success: existed ? `Deleted '${id}'` : `Key '${id}' not found` })
      }

      case 'list': {
        const keys = Array.from(cache.keys())
        return ok({ keys: keys.length ? keys.join(', ') : '(empty)'})
      }

      default:
        return err(`Unknown cache action: ${action}`)
    }
  }
}
