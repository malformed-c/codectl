import { join } from "node:path"
import { readdirSync } from "node:fs"
import { YAML } from "bun"

import type { ToolResultsTemplate } from './template'

// --- Types ---

export type JsonSchemaProperty = {
  type: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  /** Alternative names the model may use for this parameter (e.g. 'cmd' for 'command'). */
  aliases?: string[]
}

export type ToolParameters = {
  type: "object"
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: ToolParameters
  returns?: JsonSchemaProperty   // describes the result shape
}

export type ToolCall = {
  callId?: string
  name: string
  arguments: Record<string, unknown>
}

export type ToolResult = {
  callId?: string
  result: unknown
  error?: string
}

export type ToolFormat = "json" | "typescript" | "python" | "xml" | "prose"

// --- YAML loader ---

/**
 * Load a single tool from a YAML file.
 * Bun has built-in YAML.
 */
export async function loadTool(filePath: string): Promise<ToolDefinition> {
  const text = await Bun.file(filePath).text()
  const raw = YAML.parse(text) as ToolDefinition

  if (!raw || !raw.name || !raw.description || !raw.parameters) {
    throw new Error(`Invalid tool definition in ${filePath}: missing name, description, or parameters`)
  }

  return raw
}

/**
 * Load all tools from a directory of YAML files.
 */
export async function loadToolsDir(dirPath: string): Promise<ToolDefinition[]> {
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))

  return Promise.all(files.map((f) => loadTool(join(dirPath, f))))
}

// --- Renderers ---

/**
 * Render tool definitions to a string in the specified format.
 * This string goes inside the availableTools template pair.
 */
export function renderTools(tools: ToolDefinition[], format: ToolFormat = "json"): string {
  switch (format) {
    case "json": return renderJson(tools)
    case "typescript": return renderTypeScript(tools)
    case "python": return renderPython(tools)
    case "xml": return renderXml(tools)
    case "prose": return renderProse(tools)
  }
}

// --- JSON ---

function renderJson(tools: ToolDefinition[]): string {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        ...t.parameters,
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties).map(([k, { aliases: _aliases, ...prop }]) => [k, prop])
        ),
      },
      ...(t.returns ? { returns: t.returns } : {}),
    })),
    null,
    2
  )
}

// --- Type mapping helpers ---

function jsonTypeToTs(prop: JsonSchemaProperty, inline = false): string {
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(" | ")

  switch (prop.type) {
    case "string": return "string"
    case "number":
    case "integer": return "number"
    case "boolean": return "boolean"
    case "array": return prop.items ? `${jsonTypeToTs(prop.items)}[]` : "unknown[]"
    case "object": {
      if (!prop.properties) return "Record<string, unknown>"
      // Render as inline type literal: { key: type; key2: type }
      const fields = Object.entries(prop.properties).map(([k, v]) => `${k}: ${jsonTypeToTs(v)}`)

      return inline ? `{ ${fields.join("; ")} }` : `{\n${fields.map((f) => `  ${f}`).join("\n")}\n}`
    }

    default: return "unknown"
  }
}

function jsonTypeToPy(prop: JsonSchemaProperty): string {
  if (prop.enum) return `Literal[${prop.enum.map((v) => JSON.stringify(v)).join(", ")}]`

  switch (prop.type) {
    case "string": return "str"
    case "number": return "float"
    case "integer": return "int"
    case "boolean": return "bool"
    case "array": return prop.items ? `list[${jsonTypeToPy(prop.items)}]` : "list"
    case "object": return "dict"

    default: return "Any"
  }
}

// --- TypeScript ---

function renderTypeScript(tools: ToolDefinition[]): string {
  return tools.map((tool) => {
    const { properties, required = [] } = tool.parameters
    const req = new Set(required)

    // JSDoc block
    const jsdocLines = [
      ` * ${tool.description}`,
      ' *',
      ...Object.entries(properties).map(([name, prop]) => {
        const desc = prop.description ? ` - ${prop.description}` : ""

        return ` * @param ${name}${desc}`
      }),
      ' *',
      ...Object.entries(tool.returns?.properties ?? []).map(([name, prop]) => {
        const desc = prop.description ? ` - ${prop.description}` : ""

        return ` * @returns ${name}${desc}`
      }),
    ]

    const jsdoc = ["/**", ...jsdocLines, " */"].join("\n")

    // Signature
    const params = Object.entries(properties).map(([name, prop], i, arr) => {
      const comma = i < arr.length - 1 ? "," : ""
      return `  ${name}${req.has(name) ? "" : "?"}: ${jsonTypeToTs(prop, true)}${comma}`
    })

    const returnType = tool.returns ? jsonTypeToTs(tool.returns, true) : "void"

    return [
      jsdoc,
      `function ${tool.name}(`,
      ...params,
      `): ${returnType}`,
    ].join("\n")
  }).join("\n\n")
}

// --- Python ---

function renderPython(tools: ToolDefinition[]): string {
  const allProps = [
    ...tools.flatMap((t) => Object.values(t.parameters.properties)),
    ...tools.flatMap((t) => t.returns?.properties ? Object.values(t.returns.properties) : []),
  ]
  const typings = [
    ...(allProps.some((p) => p.enum) ? ["Literal"] : []),
    ...(allProps.some((p) => p.type === "object") ? ["Any"] : []),
  ]
  const header = typings.length ? [`from typing import ${typings.join(", ")}`, ""] : []

  const fns = tools.map((tool) => {
    const { properties, required = [] } = tool.parameters
    const req = new Set(required)

    const params = Object.entries(properties)
      .sort(([a], [b]) => (req.has(a) ? 0 : 1) - (req.has(b) ? 0 : 1))
      .map(([name, prop]) => {
        const pyType = jsonTypeToPy(prop)

        return req.has(name) ? `${name}: ${pyType}` : `${name}: ${pyType} = None`
      })

    const returnType = tool.returns ? jsonTypeToPy(tool.returns) : "None"

    // Google-style docstring
    const docLines = [`    """${tool.description}`]

    const argLines = Object.entries(properties).map(([name, prop]) => {
      const desc = prop.description ?? ""

      return `        ${name}: ${desc}`
    })

    if (argLines.length) {
      docLines.push("    Args:", ...argLines)
    }

    if (tool.returns) {
      const retLines = tool.returns.properties
        ? Object.entries(tool.returns.properties).map(([name, prop]) =>
          `        ${name}: ${prop.description ?? ""}`
        )
        : [`        ${tool.returns.description ?? ""}`]

      docLines.push("    Returns:", ...retLines)
    }

    docLines.push(`    """`)

    return [
      `def ${tool.name}(${params.join(", ")}) -> ${returnType}:`,
      ...docLines,
      `    ...`,
    ].join("\n")
  })

  return [...header, ...fns].join("\n\n")
}

// --- Stubs ---

function renderXml(_tools: ToolDefinition[]): string {
  // TODO: implement XML rendering
  // <tools><tool><name>...</name><description>...</description><parameters>...</parameters></tool></tools>
  throw new Error("XML tool rendering not yet implemented")
}

function renderProse(_tools: ToolDefinition[]): string {
  // TODO: implement prose rendering
  // "You have access to the following tools:\n- mode: Switch interaction mode..."
  throw new Error("Prose tool rendering not yet implemented")
}

// --- Tool call parsing ---

/**
 * Parse a raw tool call string (extracted by template parser) into ToolCall[].
 * Handles both Mistral rich format and simple JSON array.
 */
export function parseToolCalls(raw: string): ToolCall[] {
  const text = raw.trim()

  // Rich format detection (Mistral-style)
  // [CALL_ID]id123[ARGS]{"param": "val"} or just tool_name[ARGS]{...}
  // TODO Unhardcode
  if (text.includes('[ARGS]')) {
    let callId: string | undefined
    let name = ''
    let argsPart = ''

    if (text.includes('[CALL_ID]')) {
      const callIdMatch = text.match(/\[CALL_ID\](.*?)\[ARGS\]/)
      const nameMatch = text.match(/^(.*?)\[CALL_ID\]/)

      if (callIdMatch) callId = callIdMatch[1]!.trim()
      if (nameMatch) name = nameMatch[1]!.trim()

      const argsIndex = text.indexOf('[ARGS]')
      argsPart = text.slice(argsIndex + 6).trim()

    } else {
      const [namePart, ...rest] = text.split('[ARGS]')
      name = namePart!.trim()
      argsPart = rest.join('[ARGS]').trim()
    }

    try {
      return [{
        callId,
        name: name || 'unknown',
        arguments: JSON.parse(argsPart),
      }]

    } catch (err) {
      throw new Error(`Failed to parse tool arguments as JSON: ${err}`)
    }
  }

  // Fallback to pure JSON
  try {
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]

    return arr.map((item: any) => ({
      callId: item.id ?? item.callId,
      name: item.name ?? item.tool,
      arguments: item.arguments ?? item.args ?? item.parameters ?? {},
    }))

  } catch (err) {
    // If not JSON and not rich format, maybe it's just a tool name? (not recommended)
    throw new Error(`Unrecognized tool call format: ${text}`)
  }
}

/**
 *  Render a tool result back into the conversation.
*/
export function renderToolResult(result: ToolResult, T?: ToolResultsTemplate): string {
  const json = JSON.stringify(
    result.error
      ? { error: result.error }
      : { result: result.result },
    null,
    2
  )

  if (T) {
    // TODO add multiple tools support
    return `${T.wrap[0]}${T.rich?.callId}${result.callId}${T.rich?.content}${json}${T.wrap[1]}`
  }

  return json
}

// --- Argument resolution ---

/**
 * Resolve model-provided args against a tool definition.
 *
 * Three resolution steps, applied in order:
 *  1. Alias remapping  - if the model used an alias (e.g. "cmd"), remap to
 *     the canonical property name (e.g. "command").
 *  2. Positional fill  - required params that are still missing get filled
 *     from leftover (unrecognised) keys in the order they appear in `required`.
 *  3. Single-required shorthand - if there is exactly one required param and
 *     the model provided exactly one value under *any* key, use it.
 */
export function resolveArgs(
  args: Record<string, unknown>,
  def: ToolDefinition
): Record<string, unknown> {
  const { properties, required = [] } = def.parameters
  const resolved: Record<string, unknown> = {}

  // Build a reverse alias map: alias -> canonical
  const aliasMap = new Map<string, string>()
  for (const [canonical, prop] of Object.entries(properties)) {
    for (const alias of prop.aliases ?? []) {
      aliasMap.set(alias, canonical)
    }
  }

  // Step 1: remap aliases + collect unrecognised keys
  const unrecognised: [string, unknown][] = []
  for (const [key, val] of Object.entries(args)) {
    const canonical = aliasMap.get(key) ?? (properties[key] ? key : null)
    if (canonical) {
      resolved[canonical] = val

    } else {
      unrecognised.push([key, val])
    }
  }

  // Step 2: positional fill - match leftover values to still-missing required params
  const missingRequired = required.filter((r) => !(r in resolved))

  if (unrecognised.length > 0 && missingRequired.length > 0) {
    // If exactly one required and one leftover: always fill it (single-required shorthand)
    const fillCount = Math.min(unrecognised.length, missingRequired.length)
    for (let i = 0; i < fillCount; i++) {
      resolved[missingRequired[i]!] = unrecognised[i]![1]
    }
  }

  // Pass through any remaining recognised optional params that weren't aliased
  for (const [key, val] of Object.entries(args)) {
    if (!(key in resolved) && properties[key]) {
      resolved[key] = val
    }
  }

  return resolved
}

// --- Built-in tools ---

export const ModeTool: ToolDefinition = {
  name: "mode",
  description:
    "Switch the current interaction mode. " +
    "Use 'agent' when you want autonomous tool-driven work. " +
    "Use 'codeplan' when you want to design and validate a structured code change plan. " +
    "Use 'chat' for general conversation.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["chat", "agent", "codeplan"],
        description: "Target mode to switch to",
      },
      reason: {
        type: "string",
        description: "Brief reason for switching modes",
      },
    },
    required: ["mode"],
  },
  returns: {
    type: "object",
    properties: {
      switched: { type: "string", description: "The mode that was activated" },
      error: { type: "string", description: "Error message if switch failed" },
    },
  },
}

/**
 * Tool for storing and retrieving arbitrary values keyed by call ID.
 * Lets the model cache expensive results and re-use them across turns.
 */
export const CallIdCacheTool: ToolDefinition = {
  name: "call_cache",
  description:
    "Store or retrieve a value in the call-ID cache. " +
    "Use 'set' to save a result you want to reference later, 'get' to retrieve it, " +
    "'list' to see all stored keys, and 'delete' to remove one.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "get", "delete", "list"],
        description: "Cache operation to perform.",
        aliases: ["op", "operation"],
      },
      id: {
        type: "string",
        description: "Cache key (call ID or any label).",
        aliases: ["key", "call_id", "callId"],
      },
      value: {
        type: "string",
        description: "Value to store (only for 'set').",
        aliases: ["data", "result", "content"],
      },
    },
    required: ["action"],
  },
  returns: {
    type: "object",
    properties: {
      value: { type: "string", description: "Retrieved value (for 'get')." },
      keys: { type: "string", description: "Comma-separated list of keys (for 'list')." },
      success: { type: "string", description: "Confirmation message." },
    },
  },
}

// --- Smoke test ---

if (import.meta.main) {
  console.log("=== json ===")
  console.log(renderTools([ModeTool], "json"))

  console.log("\n=== typescript ===")
  console.log(renderTools([ModeTool], "typescript"))

  console.log("\n=== python ===")
  console.log(renderTools([ModeTool], "python"))

  console.log("\n=== parseToolCalls ===")
  const raw = JSON.stringify([{ name: "mode", arguments: { mode: "code/plan", reason: "user wants to edit files" } }])
  console.log(parseToolCalls(raw))

  console.log("\n=== renderToolResult ===")
  console.log(renderToolResult({ result: { switched: "code/plan" } }))
  console.log(renderToolResult({ result: null, error: "unknown mode" }))
}
