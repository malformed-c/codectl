import type { ToolDefinition } from '../tool'
import type { ToolHandler } from '../orchestrator'

// --- extract tool ---
// Pull a value out of structured or unstructured text.
// Avoids needing bash+jq or regex shell escaping for common patterns.

export const ExtractTool: ToolDefinition = {
  name: 'extract',
  description: 'Extract a value from text using a dot-path (JSON), regex, or line range. Useful for pulling fields out of tool output without shelling out to jq or awk.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The input text to extract from.' },
      method: { type: 'string', enum: ['json', 'regex', 'lines'], description: 'Extraction strategy.' },
      path: { type: 'string', description: 'For json: dot-notation path, e.g. "a.b.0.c".' },
      pattern: { type: 'string', description: 'For regex: JS regex string. First capture group (or full match) returned.' },
      from: { type: 'number', description: 'For lines: 1-indexed start line (inclusive).' },
      to: { type: 'number', description: 'For lines: 1-indexed end line (inclusive, default = same as from).' },
    },
    required: ['text', 'method'],
  },
  returns: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'The extracted value as a string.' },
    },
  },
}

export function createExtractHandler(): ToolHandler {
  return async (args) => {
    const text = args.text as string
    const method = args.method as string

    if (method === 'json') {
      const path = args.path as string | undefined
      if (!path) return { result: null, error: "'path' required for json extraction" }

      let parsed: unknown
      try { parsed = JSON.parse(text) }
      catch { return { result: null, error: 'Input is not valid JSON' } }

      let cur: unknown = parsed
      for (const key of path.split('.')) {
        if (cur === null || typeof cur !== 'object') {
          return { result: null, error: `Path segment '${key}' not reachable` }
        }

        cur = (cur as Record<string, unknown>)[key]
        if (cur === undefined) return { result: null, error: `Key '${key}' not found` }
      }

      const value = typeof cur === 'string' ? cur : JSON.stringify(cur, null, 2)
      return { result: value }
    }

    if (method === 'regex') {
      const pattern = args.pattern as string | undefined
      if (!pattern) return { result: null, error: "'pattern' required for regex extraction" }

      let re: RegExp
      try { re = new RegExp(pattern) }
      catch (e) { return { result: null, error: `Invalid regex: ${e}` } }

      const m = re.exec(text)
      if (!m) return { result: null, error: 'Pattern did not match' }

      return { result: m[1] ?? m[0] }
    }

    if (method === 'lines') {
      const lines = text.split('\n')
      const from = Math.max(1, (args.from as number | undefined) ?? 1)
      const to = Math.max(from, (args.to as number | undefined) ?? from)

      const slice = lines.slice(from - 1, to)

      return { result: slice.join('\n') }
    }

    return { result: null, error: `Unknown method '${method}'. Use json, regex, or lines.` }
  }
}

// --- json tool ---
// Lightweight JSON manipulation without shelling out to jq.

export const JsonTool: ToolDefinition = {
  name: 'json',
  description: 'Parse, query, or pretty-print JSON. Use get for dot-notation field access, keys for inspecting object structure, set for in-place updates, pretty for formatting.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'keys', 'set', 'pretty'], description: 'Operation to perform.' },
      text: { type: 'string', description: 'JSON string to operate on.' },
      path: { type: 'string', description: 'Dot-notation path for get/set, e.g. "response.items.0.name".' },
      value: { type: 'string', description: 'For set: the new value (parsed as JSON if valid, otherwise treated as string).' },
    },
    required: ['action', 'text'],
  },
}

export function createJsonHandler(): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const text = args.text as string

    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch { return { result: null, error: 'Input is not valid JSON' } }

    if (action === 'pretty') {
      return { result: JSON.stringify(parsed, null, 2) }
    }

    if (action === 'keys') {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { result: null, error: 'keys requires a JSON object at the root' }
      }

      return { result: Object.keys(parsed as object).join(', ') }
    }

    if (action === 'get') {
      const path = args.path as string | undefined
      if (!path) return { result: null, error: "'path' required for get" }

      let cur: unknown = parsed
      for (const key of path.split('.')) {
        if (cur === null || typeof cur !== 'object') {
          return { result: null, error: `Cannot traverse into '${key}'` }
        }

        cur = (cur as Record<string, unknown>)[key]
        if (cur === undefined) return { result: null, error: `Key '${key}' not found` }
      }

      return { result: typeof cur === 'string' ? cur : JSON.stringify(cur, null, 2) }
    }

    if (action === 'set') {
      const path = args.path as string | undefined
      const val = args.value as string | undefined
      if (!path) return { result: null, error: "'path' required for set" }
      if (val === undefined) return { result: null, error: "'value' required for set" }

      let newVal: unknown
      try { newVal = JSON.parse(val) } catch { newVal = val }

      // Deep clone to avoid mutation
      const root = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
      const keys = path.split('.')
      let cur: Record<string, unknown> = root
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
        cur = cur[k] as Record<string, unknown>
      }
      cur[keys[keys.length - 1]!] = newVal

      return { result: JSON.stringify(root, null, 2) }
    }

    return { result: null, error: `Unknown action '${action}'` }
  }
}

// --- instantiate tool ---
// Fill a template string with named placeholders.
// The model can compose prompts, file paths, or code fragments without needing
// string manipulation in bash.

export const InstantiateTool: ToolDefinition = {
  name: 'instantiate',
  description: 'Fill a template string containing {{name}} placeholders with provided values. Returns the rendered string. Useful for constructing file contents, prompts, or paths.',
  parameters: {
    type: 'object',
    properties: {
      template: { type: 'string', description: 'Template string with {{variable}} placeholders.' },
      vars: {
        type: 'object',
        description: 'Object mapping placeholder names to their replacement values.',
        properties: {},
      },
    },
    required: ['template', 'vars'],
  },
}

export function createInstantiateHandler(): ToolHandler {
  return async (args) => {
    const template = args.template as string
    const vars = args.vars as Record<string, string> | undefined

    if (!vars || typeof vars !== 'object') {
      return { result: null, error: "'vars' must be an object" }
    }

    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        return String(vars[name])
      }

      return `{{${name}}}`  // leave unknown placeholders intact
    })

    // Report any unfilled placeholders as a warning in the result
    const remaining = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])

    return {
      result: rendered,
      ...(remaining.length ? { error: `Unfilled placeholders: ${remaining.join(', ')}` } : {}),
    }
  }
}

export const TransformTools: ToolDefinition[] = [ExtractTool, JsonTool, InstantiateTool]

export function createTransformHandlers(): Record<string, ToolHandler> {
  return {
    extract: createExtractHandler(),
    json: createJsonHandler(),
    instantiate: createInstantiateHandler(),
  }
}
