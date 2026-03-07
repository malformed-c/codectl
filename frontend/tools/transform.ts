import type { ToolDefinition } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { SerializedRound } from '../round'

// --- Interfaces ---

export interface MemoryAccess {
  get(key: string): string | undefined
  set(key: string, value: string): void
  has(key: string): boolean
}

export interface HistoryAccess {
  /** Return all committed serialized rounds, newest last. */
  getCommitted(): SerializedRound[]
}

// --- Helpers ---

/** Resolve input text from inline text, memory key, or turn offset. */
function resolveSource(
  text: string | undefined,
  key: string | undefined,
  turn: number | undefined,
  memory: MemoryAccess,
  history: HistoryAccess,
): { value: string } | { error: string } {
  if (turn !== undefined) {
    const content = getUserTurnText(history.getCommitted(), turn)
    if (content === undefined) return { error: `No user turn at offset ${turn}` }

    return { value: content }
  }

  if (key) {
    const val = memory.get(key)
    if (val === undefined) return { error: `Memory key '${key}' not found` }

    return { value: val }
  }

  if (text !== undefined) return { value: text }

  return { error: "'turn' is required for extract" }
}

/**
 * Walk committed history newest-to-oldest and return the text of the Nth
 * user turn (offset 0 = latest, 1 = second-latest, etc.).
 * Only top-level ChatRounds are counted.
 */
function getUserTurnText(rounds: SerializedRound[], offset: number): string | undefined {
  const turns: string[] = []

  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!

    if (r.kind === 'chat') {
      turns.push(r.user.map(s => s.text).join(''))
      continue
    }

    if (r.kind === 'agent') {
      turns.push(r.trigger.map(s => s.text).join(''))
    }
  }

  return turns[offset]
}

/**
 * Extract all fenced code blocks from text.
 * Returns array of { lang, code } objects.
 */
function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = []
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: (m[1] ?? '').trim(), code: (m[2] ?? '').trimEnd() })
  }

  return blocks
}

/**
 * Parse a dot/bracket path into segments.
 * Supports: "a.b.0.c", "a[0].b[1].c", "a.b[2].c.d[3]"
 * "." or "" returns an empty segment list (identity).
 */
function parsePath(path: string): string[] {
  if (path === '.' || path === '') return []
  // Normalise bracket notation to dot notation: a[0].b -> a.0.b
  const normalised = path.replace(/\[(\w+)\]/g, '.$1')
  return normalised.split('.').filter(k => k !== '')
}

function looksLikeJsonPayload(text: string): boolean {
  const trimmed = text.trim()

  return (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

// --- extract tool ---

export const ExtractTool: ToolDefinition = {
  name: 'extract',
  description:
    'Extract a value from a user message turn or memory key. ' +
    'Methods: json (dot-path), regex, lines, codeblocks. ' +
    'Source: turn (user message offset - 0 = latest). ' +
    'Optionally save result to memory with save_to.',
  parameters: {
    type: 'object',
    properties: {
      turn: { type: 'number', description: 'User message offset (0 = latest, 1 = second-latest, ...). Default: 0.' },
      method: { type: 'string', enum: ['json', 'regex', 'lines', 'codeblocks'], description: 'Extraction strategy.' },
      path: { type: 'string', description: 'For json: dot-notation path, e.g. "a.b.0.c".' },
      pattern: { type: 'string', description: 'For regex: JS regex string. First capture group (or full match) returned.' },
      from: { type: 'number', description: 'For lines: 1-indexed start line (inclusive).' },
      to: { type: 'number', description: 'For lines: 1-indexed end line (inclusive, default = same as from).' },
      index: { type: 'number', description: 'For codeblocks: return only this block (0-indexed). Omit to return all blocks as JSON.' },
      lang: { type: 'string', description: 'For codeblocks: filter by language tag (e.g. "python", "json").' },
      save_to: { type: 'string', description: 'Store result in this memory key.' },
    },
    required: ['method'],
  },
  returns: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'The extracted value (or JSON array for codeblocks without index).' },
    },
  },
}

export function createExtractHandler(memory: MemoryAccess, history: HistoryAccess): ToolHandler {
  return async (args) => {
    const method = args.method as string
    const saveTo = args.save_to as string | undefined

    // codeblocks defaults to turn:0 if no source specified
    const turnArg = args.turn as number | undefined
    const effectiveTurn =
      method === 'codeblocks' && turnArg === undefined
        ? 0
        : turnArg

    const src = resolveSource(
      undefined,
      undefined,
      effectiveTurn,
      memory,
      history,
    )
    if ('error' in src) return err(src.error)
    const text = src.value

    let extracted: string | null = null

    if (method === 'json') {
      const path = args.path as string | undefined
      if (!path) return err("'path' required for json extraction")

      let parsed: unknown
      try { parsed = JSON.parse(text) } catch {
        // Text may contain a JSON payload embedded in surrounding prose (e.g. a user
        // message that starts with instructions before the JSON). Find the first
        // { or [ and try to parse from there.
        const jsonStart = text.search(/[{[]/)
        if (jsonStart !== -1) {
          try { parsed = JSON.parse(text.slice(jsonStart)) }
          catch { return err('Input is not valid JSON') }

        } else {
          return err('Input is not valid JSON')
        }
      }

      // "." or empty path means identity — return the whole root
      const segments = parsePath(path)

      let cur: unknown = parsed
      for (const k of segments) {
        if (cur === null || typeof cur !== 'object') {
          return err(`Path segment '${k}' not reachable`)
        }

        cur = (cur as Record<string, unknown>)[k]
        if (cur === undefined) return err(`Key '${k}' not found`)
      }

      extracted = typeof cur === 'string' ? cur : JSON.stringify(cur)

    } else if (method === 'regex') {
      const pattern = args.pattern as string | undefined
      if (!pattern) return err("'pattern' required for regex extraction")

      let re: RegExp
      try { re = new RegExp(pattern, 's') }
      catch (e) { return err(`Invalid regex: ${e}`) }

      const m = re.exec(text)
      if (!m) return err('Pattern did not match')
      extracted = m[1] ?? m[0]

    } else if (method === 'lines') {
      const lines = text.split('\n')
      const from = Math.max(1, (args.from as number | undefined) ?? 1)
      const to = Math.max(from, (args.to as number | undefined) ?? from)
      extracted = lines.slice(from - 1, to).join('\n')

    } else if (method === 'codeblocks') {
      let blocks = extractCodeBlocks(text)

      // Fallback: if no fenced blocks exist but the full message is raw JSON,
      // treat it as one virtual json block so turn offsets still work.
      if (blocks.length === 0 && looksLikeJsonPayload(text)) {
        blocks = [{ lang: 'json', code: text.trim() }]
      }

      // Filter by language if specified
      const langFilter = args.lang as string | undefined
      if (langFilter) {
        blocks = blocks.filter(b => b.lang === langFilter || b.lang.startsWith(langFilter + ' '))
      }

      const indexArg = args.index as number | undefined
      if (indexArg !== undefined) {
        const block = blocks[indexArg]
        if (!block) return err(`No code block at index ${indexArg} (found ${blocks.length})`)
        extracted = block.code

      } else {
        // Return all as JSON array
        extracted = JSON.stringify(blocks)
      }

    } else {
      return err(`Unknown method '${method}'. Use json, regex, lines, or codeblocks.`)
    }

    if (saveTo && extracted !== null) {
      memory.set(saveTo, extracted)
    }

    return ok(extracted)
  }
}

// --- json tool ---
// Lightweight JSON manipulation without shelling out to jq.

export const JsonTool: ToolDefinition = {
  name: 'json',
  description:
    'Parse, query, or mutate JSON. Source is inline text or a memory key. ' +
    'Mutations (set, append, delete) write result back to the same memory key.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'keys', 'set', 'append', 'delete', 'pretty'],
        description: 'Operation to perform.',
      },
      text: { type: 'string', description: 'Inline JSON string to operate on.' },
      key: { type: 'string', description: 'Memory key to read (and write back) JSON from.' },
      path: { type: 'string', description: 'Dot-notation path for get/set/delete, e.g. "response.items.0.name".' },
      value: { type: 'string', description: 'For set/append: new value (parsed as JSON if valid, else string).' },
    },
    required: ['action'],
  },
}

export function createJsonHandler(memory: MemoryAccess): ToolHandler {
  return async (args) => {
    const action = args.action as string
    const memKey = args.key as string | undefined

    const src =
      memKey
        ? (() => { const v = memory.get(memKey); return v !== undefined ? { value: v } : { error: `Memory key '${memKey}' not found` } })()
        : args.text !== undefined
          ? { value: args.text as string }
          : { error: "Provide 'text' or 'key'" }

    if ('error' in src) return err(src.error)

    let parsed: unknown
    try { parsed = JSON.parse(src.value) }
    catch { return err('Input is not valid JSON') }

    const persist = (root: unknown) => {
      const out = JSON.stringify(root)

      if (memKey) memory.set(memKey, out)

      return ok(out)
    }

    if (action === 'pretty') return ok(JSON.stringify(parsed, null, 2))

    if (action === 'keys') {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return err('keys requires a JSON object at the root')
      }

      return ok(Object.keys(parsed as object).join(', '))
    }

    if (action === 'get') {
      const path = args.path as string | undefined
      if (!path) return err("'path' required for get")

      let cur: unknown = parsed
      for (const k of parsePath(path)) {
        if (cur === null || typeof cur !== 'object') return err(`Cannot traverse into '${k}'`)

        cur = (cur as Record<string, unknown>)[k]
        if (cur === undefined) return err(`Key '${k}' not found`)
      }

      return ok(typeof cur === 'string' ? cur : JSON.stringify(cur))
    }

    if (action === 'set' || action === 'append' || action === 'delete') {
      const path = args.path as string | undefined
      if (!path) return err(`'path' required for ${action}`)

      const root = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
      const keys = parsePath(path)
      let cur: Record<string, unknown> = root
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
        cur = cur[k] as Record<string, unknown>
      }

      const lastKey = keys[keys.length - 1]!

      if (action === 'delete') {
        delete cur[lastKey]

        return persist(root)
      }

      const val = args.value as string | undefined
      if (val === undefined) return err(`'value' required for ${action}`)
      let newVal: unknown
      try { newVal = JSON.parse(val) } catch { newVal = val }

      if (action === 'append') {
        const existing = cur[lastKey]
        if (Array.isArray(existing)) {
          existing.push(newVal)

        } else if (typeof existing === 'string' && typeof newVal === 'string') {
          cur[lastKey] = existing + newVal

        } else {
          cur[lastKey] = newVal
        }

      } else {
        cur[lastKey] = newVal
      }

      return persist(root)
    }

    return err(`Unknown action '${action}'`)
  }
}

// --- instantiate tool ---

const BUILTIN_TEMPLATES: Record<string, unknown> = {
  codeplan: {
    meta: { description: '', order: 0 },
    tasks: [],
  },
}

export const InstantiateTool: ToolDefinition = {
  name: 'instantiate',
  description:
    'Instantiate a built-in JSON template (e.g. codeplan) or fill a {{placeholder}} template string. ' +
    'Use save_to to store directly into memory. Built-in templates: codeplan.',
  parameters: {
    type: 'object',
    properties: {
      template_name: {
        type: 'string',
        enum: ['codeplan'],
        description: 'Built-in JSON template to instantiate.',
      },
      template: {
        type: 'string',
        description: 'Template string with {{variable}} placeholders.',
      },
      vars: {
        type: 'object',
        description: 'Values for {{placeholder}} substitution.',
        properties: {},
      },
      save_to: { type: 'string', description: 'Memory key to store the result in.' },
    },
    required: [],
  },
}

export function createInstantiateHandler(memory: MemoryAccess): ToolHandler {
  return async (args) => {
    const templateName = args.template_name as string | undefined
    const templateStr = args.template as string | undefined
    const saveTo = args.save_to as string | undefined
    const vars = args.vars as Record<string, string> | undefined

    let rendered: string

    if (templateName) {
      const tpl = BUILTIN_TEMPLATES[templateName]
      if (!tpl) return err(`Unknown template '${templateName}'`)
      rendered = JSON.stringify(tpl, null, 2)

    } else if (templateStr !== undefined) {
      if (!vars || typeof vars !== 'object') {
        return err("'vars' must be an object when using template string")
      }

      rendered = templateStr.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{{${name}}}`
      )
      const remaining = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])
      if (remaining.length) {
        return err(`Unfilled placeholders: ${remaining.join(', ')}`)
      }

    } else {
      return err("Provide either 'template_name' or 'template'")
    }

    if (saveTo) {
      memory.set(saveTo, rendered)
      return ok({ saved_to: saveTo})
    }

    return ok(rendered)
  }
}

export const TransformTools: ToolDefinition[] = [ExtractTool, JsonTool, InstantiateTool]

export function createTransformHandlers(memory: MemoryAccess, history: HistoryAccess): Record<string, ToolHandler> {
  return {
    extract: createExtractHandler(memory, history),
    json: createJsonHandler(memory),
    instantiate: createInstantiateHandler(memory),
  }
}
