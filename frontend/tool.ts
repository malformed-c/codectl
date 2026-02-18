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

export type ToolFormat = "json" | "xml" | "prose"

// --- YAML loader ---

/**
 * Load a single tool from a YAML file.
 * Bun has built-in YAML.
 */
export async function loadTool(filePath: string): Promise<ToolDefinition> {
  const file = Bun.file(filePath)
  const text = await file.text()

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
    case "xml": return renderXml(tools)
    case "prose": return renderProse(tools)
  }
}

function renderJson(tools: ToolDefinition[]): string {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2
  )
}

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
}

// --- Smoke test ---

if (import.meta.main) {
  console.log("=== renderTools (json) ===")
  console.log(renderTools([ModeTool], "json"))

  console.log("\n=== parseToolCalls ===")
  const raw = JSON.stringify([{ name: "mode", arguments: { mode: "code/plan", reason: "user wants to edit files" } }])
  console.log(parseToolCalls(raw))

  console.log("\n=== renderToolResult ===")
  console.log(renderToolResult({ result: { switched: "code/plan" } }))
  console.log(renderToolResult({ result: null, error: "unknown mode" }))
}
