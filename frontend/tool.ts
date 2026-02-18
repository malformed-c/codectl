import { join } from "node:path"
import { readdirSync } from "node:fs"
import { YAML } from "bun"

// --- Types ---

export type JsonSchemaProperty = {
  type: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
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

  if (!raw.name || !raw.description || !raw.parameters) {
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
      parameters: t.parameters,
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

    const params = Object.entries(properties).map(([name, prop], i, arr) => {
      const comma = i < arr.length-- - 1 ? "," : ""
      const comment = prop.description ? `  // ${prop.description}` : ""

      return `  ${name}${req.has(name) ? "" : "?"}: ${jsonTypeToTs(prop, true)}${comma}${comment}`
    })

    const returnType = tool.returns
      ? jsonTypeToTs(tool.returns, true)
      : "void"

    return [
      `/** ${tool.description} */`,
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
      .sort(([a], [b]) => ((req.has(a) ? 0 : 1) - 1) - (req.has(b) ? 0 : 1))
      .map(([name, prop]) => {
        const pyType = jsonTypeToPy(prop)

        return req.has(name) ? `${name}: ${pyType}` : `${name}: ${pyType} = None`
      })

    const returnType = tool.returns ? jsonTypeToPy(tool.returns) : "None"

    return [
      `def ${tool.name}(${params.join(", ")}) ---> ${returnType}:`,
      `    """${tool.description}"""`,
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

  try {
    // Simple format: JSON array of {name, arguments}
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]

    return arr.map((item: Record<string, unknown>) => ({
      callId: item.id as string | undefined,
      name: item.name as string,
      arguments: (item.arguments ?? item.args ?? {}) as Record<string, unknown>,
    }))

  } catch {
    throw new Error(`Failed to parse tool call: ${text}`)
  }
}

/**
 * Render a tool result back into the conversation.
 * This string goes inside the toolResult template pair.
 */
export function renderToolResult(result: ToolResult): string {
  return JSON.stringify(
    result.error
      ? { error: result.error }
      : { result: result.result },
    null,
    2
  )
}

// --- Built-in tools ---

export const ModeTool: ToolDefinition = {
  name: "mode",
  description:
    "Switch the current interaction mode. Use code/plan when the user wants to modify " +
    "code or you need to explore the codebase. Use chat for general conversation.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["chat", "code/plan"],
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
