// --- Types ---

import consola from 'consola'
import { match, P } from 'ts-pattern'

type TemplatePair = [open: string, close: string]

export type FimTemplate = {
  prefix: string
  middle: string
  suffix: string
}

export type ToolCallsTemplate = {
  wrap: TemplatePair            // [TOOL_CALLS] ... (outer)

  // Mistral
  rich?: {
    callId: string             // [CALL_ID] - precedes the call id
    args: string               // [ARGS] - precedes arguments
  }
}

export type ToolResultsTemplate = {
  wrap: TemplatePair            // [TOOL_RESULTS] ... [/TOOL_RESULTS]

  // Mistral
  rich?: {
    callId: string             // [CALL_ID] - links result back to a call id
    content: string            // [TOOL_CONTENT] - precedes the content
  }
}

export type TextTemplate = {
  bos?: string
  eos?: string
  system?: TemplatePair
  userTurn: TemplatePair
  modelTurn: TemplatePair
  toolResult?: TemplatePair | ToolResultsTemplate
  toolCall?: TemplatePair | ToolCallsTemplate
  think?: TemplatePair
  availableTools?: TemplatePair
  fim?: FimTemplate
}

export type Role = 'system' | 'user' | 'assistant' | 'model' | 'tool_result' | 'tool_call'

/**
 * A structured tool call entry stored in history.
 * The `tool` field is the tool name; all other fields are arguments.
 */
export type StoredToolCall = {
  tool: string
  callId?: string
  [key: string]: unknown
}

/**
 * A structured tool result stored in history.
 * Holds the raw result value so it is only serialized once at render time,
 * preventing double-escaping when result is already a string.
 */
export type StoredToolResult = {
  callId?: string
  error?: string
  value?: unknown
}

export type Message = {
  role: Role
  content: string

  /** Reasoning/think block - stored separately and re-rendered before content. */
  think?: string

  /** Structured tool calls - present on tool_call messages instead of raw content. */
  calls?: StoredToolCall[]

  /** Structured tool results - present on tool_result messages instead of raw content. */
  results?: StoredToolResult[]
}

export type FimRequest = {
  prefix: string
  suffix: string
}

export type FimContent = {
  middle: string
}

export type ParsedTurn = {
  think?: string
  toolCalls?: string[]
  toolResults?: string[]
  content: string
}

export type ModelProfile = {
  name: string
  template: TextTemplate
  parameters?: Record<string, unknown>
}

export type Config = {
  api_server: string
  api_type: string
  history_path: string
  default_model: string
  available_models: string[]
  tool_format?: string
}

// --- Built-in profiles ---
//TODO add stop strings and optional newlines and trimming

export const Profiles = {
  // Mistral instruct
  mistral: {
    bos: '<s>',
    eos: '</s>',
    system: ['[SYSTEM_PROMPT]\n', '\n[/SYSTEM_PROMPT]\n'],
    userTurn: ['[INST]\n', '\n[/INST]\n'],
    modelTurn: ['', '</s>\n'],
    toolCall: {
      wrap: ['[TOOL_CALLS]', ''],
      rich: {
        callId: '[CALL_ID]',
        args: '[ARGS]',
      }
    },
    toolResult: {
      wrap: ['[TOOL_RESULTS]\n', '\n[/TOOL_RESULTS]\n'],
      rich: {
        callId: '[CALL_ID]',
        content: '[TOOL_CONTENT]',
      }
    },
    think: ['[THINK]', '[/THINK]'],
    availableTools: ['[AVAILABLE_TOOLS]\n', '\n[/AVAILABLE_TOOLS]\n'],
    fim: {
      prefix: '[PREFIX]',
      middle: '[MIDDLE]',
      suffix: '[SUFFIX]',
    },
  } satisfies TextTemplate,

  // Llama 3 instruct
  llama3: {
    bos: '<|begin_of_text|>',
    eos: '<|eot_id|>',
    system: ['<|start_header_id|>system<|end_header_id|>\n\n', '<|eot_id|>'],
    userTurn: ['<|start_header_id|>user<|end_header_id|>\n\n', '<|eot_id|>'],
    modelTurn: ['<|start_header_id|>assistant<|end_header_id|>\n\n', '<|eot_id|>'],
    toolResult: ['<|start_header_id|>tool<|end_header_id|>\n\n', '<|eot_id|>'],
    toolCall: ['<|python_tag|>', '<|eot_id|>'],
    think: ['<|start_header_id|>think<|end_header_id|>\n\n', '<|eot_id|>'],
  } satisfies TextTemplate,

  // Qwen 2.5 instruct
  qwen: {
    bos: '',
    eos: '<|im_end|>',
    system: ['<|im_start|>system\n', '<|im_end|>\n'],
    userTurn: ['<|im_start|>user\n', '<|im_end|>\n'],
    modelTurn: ['<|im_start|>assistant\n', '<|im_end|>\n'],
    toolResult: ['<|im_start|>tool\n', '<|im_end|>\n'],
    toolCall: ['<|im_start|>assistant\n', '<|im_end|>\n'],
    think: ['<think>', '</think>'],
    fim: { prefix: '<|fim_prefix|>', middle: '<|fim_middle|>', suffix: '<|fim_suffix|>' },
  } satisfies TextTemplate,

  // DeepSeek
  deepseek: {
    bos: '<｜begin▁of▁sentence｜>',
    eos: '<｜end▁of▁sentence｜>',
    system: ['', '\n\n'],
    userTurn: ['<｜User｜>', ''],
    modelTurn: ['<｜Assistant｜>', '<｜end▁of▁sentence｜>'],
    think: ['<think>', '</think>'],
    fim: { prefix: '<｜fim▁prefix｜>', middle: '<｜fim▁middle｜>', suffix: '<｜fim▁suffix｜>' },
  } satisfies TextTemplate,

  // ChatML - used by many models (Hermes, OpenHermes, etc.)
  chatml: {
    bos: '',
    eos: '<|im_end|>',
    system: ['<|im_start|>system\n', '<|im_end|>\n'],
    userTurn: ['<|im_start|>user\n', '<|im_end|>\n'],
    modelTurn: ['<|im_start|>assistant\n', '<|im_end|>\n'],
    think: ['<think>', '</think>'],
  } satisfies TextTemplate,
} as const

// TODO add customization through config
export type ProfileName = keyof typeof Profiles

// --- Helpers ---

const isPair = (v: unknown): v is TemplatePair =>
  Array.isArray(v) && v.length === 2

function wrapPair([open, close]: TemplatePair, content: string): string {
  return `${open}${content}${close}`
}

/** Resolve toolResult/toolCall union to the TemplatePair used for wrapping */
function resolveWrap(
  token: TemplatePair | ToolCallsTemplate | ToolResultsTemplate | undefined,
  fallback: TemplatePair
): TemplatePair {
  return match(token)
    .with(P.nullish, () => fallback)
    .when(isPair, (pair) => pair)
    .otherwise((t) => (t as ToolCallsTemplate | ToolResultsTemplate).wrap)
}

// --- Renderer ---

function wrap([open, close]: TemplatePair, content: string): string {
  return `${open}${content}${close}`
}

/**
 * Render structured StoredToolCall[] back to the native content string
 * for the given template (without the outer wrap tokens).
 *
 * Mistral rich:  toolname[CALL_ID]id[ARGS]{...}\ntoolname2[CALL_ID]...[ARGS]{...}
 * Simple pair:   [{"name":"bash","arguments":{"command":"ls"}}]
 */
export function renderToolCalls(calls: StoredToolCall[], template: TextTemplate): string {
  const tc = template.toolCall

  if (tc && !Array.isArray(tc) && tc.rich) {
    // Mistral-style rich format
    const { callId: callIdToken, args: argsToken } = tc.rich

    return calls.map(({ tool, callId, ...args }) => {
      const callIdPart = callId ? `${callIdToken}${callId}` : ''
      const argsPart = Object.keys(args).length ? JSON.stringify(args) : ''

      return `${tool}${callIdPart}${argsToken}${argsPart}`
    }).join('\n')
  }

  // Simple pair format - JSON array matching what the model originally produced
  return JSON.stringify(
    calls.map(({ tool, callId, ...args }) => ({
      name: tool,
      ...(callId ? { id: callId } : {}),
      arguments: args,
    }))
  )
}

/**
 * Render a StoredToolResult to the inner content string (without outer wrap tokens).
 * Serializes the result value exactly once - avoids double-escaping when result is
 * already a string (e.g. from renderTools).
 */
export function renderStoredToolResult(stored: StoredToolResult, template: TextTemplate): string {
  const tr = template.toolResult
  const isRich = tr && !Array.isArray(tr) && (tr as ToolResultsTemplate).rich

  // Serialize result - wrapped in { result: ... } or { error: ... } for model clarity.
  // This matches previous renderToolResult behavior.
  const body = JSON.stringify({
    ...(stored.callId && !isRich ? { callId: stored.callId } : {}),
    ...(stored.error ? { error: stored.error } : { result: stored.value }),
  }, null, 2)

  if (isRich) {
    const rich = (tr as ToolResultsTemplate).rich!

    return `${rich.callId}${stored.callId ?? ''}${rich.content}${body}`
  }

  return body
}

/**
 * Render multiple StoredToolResults to the inner content string (without outer wrap tokens).
 */
export function renderStoredToolResults(results: StoredToolResult[], template: TextTemplate): string {
  const tr = template.toolResult

  // Mistral-style rich format
  if (tr && !Array.isArray(tr) && (tr as ToolResultsTemplate).rich) {
    return results.map(r => renderStoredToolResult(r, template)).join('\n')
  }

  // Simple pair format - if multiple results, wrap them in a JSON array
  if (results.length > 1) {
    return JSON.stringify(results.map(r => ({
      ...(r.callId ? { callId: r.callId } : {}),
      ...(r.error ? { error: r.error } : { result: r.value })
    })), null, 2)
  }

  // Single result - backward compatible with single-object JSON
  return results[0] ? renderStoredToolResult(results[0], template) : ''
}

/**
 * Render a conversation to a single prompt string.
 * The returned string ends just after the last assistant open tag,
 * ready for the model to continue.
 */
export function render(messages: Message[], template: TextTemplate): string {
  const parts: string[] = []

  if (template.bos) parts.push(template.bos)

  for (const msg of messages) {
    const part = match(msg)
      .with({ role: 'system' }, ({ content }) =>
        template.system
          ? wrapPair(template.system, content)
          // No system token - fold into first user turn by prepending
          // (handled below by annotating the next user message)
          : content + '\n\n'
      )
      .with({ role: 'user' }, ({ content }) =>
        wrapPair(template.userTurn, content)
      )
      .with({ role: 'assistant' }, { role: 'model' }, (m) => {
        // Re-emit think block before content if the template supports it
        const thinkPart = (m.think && template.think)
          ? wrapPair(template.think, m.think)
          : ''

        return wrapPair(template.modelTurn, thinkPart + m.content)
      })
      .with({ role: 'tool_result' }, (m) => {
        const inner = m.results
          ? renderStoredToolResults(m.results, template)
          : m.content

        return wrapPair(resolveWrap(template.toolResult, template.userTurn), inner)
      })
      .with({ role: 'tool_call' }, (m) => {
        // Re-render structured calls to native format if present
        const content = m.calls?.length
          ? renderToolCalls(m.calls, template)
          : m.content

        return wrapPair(resolveWrap(template.toolCall, template.modelTurn), content)
      })
      .exhaustive()

    parts.push(part)
  }

  // Open the next assistant turn - model completes from here
  parts.push(template.modelTurn[0])

  return parts.join('')
}

/**
 * Render a FIM (fill-in-the-middle) prompt.
 * Returns null if the template has no FIM tokens defined.
 */
export function renderFim(req: FimRequest, template: TextTemplate): string | null {
  if (!template.fim) return null

  const { prefix, middle, suffix } = template.fim

  return `${prefix}${req.prefix}${suffix}${req.suffix}${middle}`
}

// --- Parser ---

/**
 * Extract content between open/close tokens. Returns null if not found.
 */
function extractBetween(text: string, [open, close]: TemplatePair): string | null {
  const start = text.indexOf(open)

  if (start === -1) return null

  const contentStart = start + open.length
  if (!close) return text.slice(contentStart).trim()

  const end = text.indexOf(close, contentStart)
  if (end === -1) return text.slice(contentStart).trim()

  return text.slice(contentStart, end).trim()
}

/**
 * Extract all occurrences of content between open/close tokens.
 */
function extractAll(text: string, [open, close]: TemplatePair): string[] {
  const results: string[] = []
  let cursor = 0

  while (true) {
    const start = text.indexOf(open, cursor)
    if (start === -1) break

    const contentStart = start + open.length

    if (!close) {
      // No closing tag - use the next occurrence of open as the boundary,
      // so multiple [TOOL_CALLS]...[TOOL_CALLS]... are each extracted separately
      const nextOpen = text.indexOf(open, contentStart)
      const end = nextOpen === -1 ? text.length : nextOpen
      const content = text.slice(contentStart, end).trim()

      if (content) results.push(content)
      cursor = end

      continue
    }

    const end = text.indexOf(close, contentStart)
    if (end === -1) {
      results.push(text.slice(contentStart).trim())

      break
    }

    results.push(text.slice(contentStart, end).trim())
    cursor = end + close.length
  }

  return results
}

/**
 * Remove all occurrences of a tagged block from text.
 */
function stripTag(text: string, [open, close]: TemplatePair): string {
  // If no closing tag, we assume the tag consumes the rest of the string
  if (!close) {
    const start = text.indexOf(open)

    if (start === -1) return text

    return text.slice(0, start).trim()
  }

  let result = text
  while (true) {
    const start = result.indexOf(open)
    if (start === -1) break

    const end = result.indexOf(close, start + open.length)
    if (end === -1) {
      // If we found an open tag but no close tag, strip everything after it
      result = result.slice(0, start)

      break
    }

    result = result.slice(0, start) + result.slice(end + close.length)
  }

  return result
}

/**
 * Parse a raw user/model responses into structured parts.
 * Strips template tokens, extracts think blocks and tool calls/responses,
 * leaving only the clean content.
 */
// TODO user support
export function parse(raw: string, template: TextTemplate): ParsedTurn {
  let text = raw

  // Strip BOS/EOS if present
  if (template.bos && text.startsWith(template.bos)) {
    text = text.slice(template.bos.length)
  }
  if (template.eos) {
    const eosIdx = text.indexOf(template.eos)
    if (eosIdx !== -1) text = text.slice(0, eosIdx)
  }

  // Strip assistant turn wrapper if the model echoed it
  if (text.startsWith(template.modelTurn[0])) {
    text = text.slice(template.modelTurn[0].length)
  }
  if (template.modelTurn[1] && text.endsWith(template.modelTurn[1])) {
    text = text.slice(0, text.length - template.modelTurn[1].length)
  }

  const result: ParsedTurn = { content: '' }

  // Extract think block
  if (template.think) {
    const think = extractBetween(text, template.think)
    if (think !== null) {
      result.think = think
      text = stripTag(text, template.think)
    }
  }

  // Extract tool calls - resolve to wrap pair regardless of rich/simple
  if (template.toolCall) {
    const pair = resolveWrap(template.toolCall, template.modelTurn)
    const calls = extractAll(text, pair)
    if (calls.length > 0) {
      result.toolCalls = calls
      text = stripTag(text, pair)
    }
  }

  result.content = text.trim()

  return result
}

// --- Smoke test ---

if (import.meta.main) {
  const template = Profiles.mistral

  const messages: Message[] = [
    { role: "system", content: "You are a code agent." },
    { role: "user", content: "Add JWT verification to auth.py" },
    { role: "tool_result", content: '<file path="src/auth.py">def login(): pass</file>' },
    { role: "assistant", content: "I will add the verify_token function." },
    { role: "user", content: "resolve stream_jwt_001" },
  ]

  consola.log("=== render ===")
  consola.log(render(messages, template))

  consola.log("\n=== renderFim ===")
  consola.log(renderFim({
    prefix: "def verify_token(token: str) -> dict:\n    ",
    suffix: "\n\ndef login(): pass",
  }, template))

  consola.log("\n=== parse (mistral) ===")
  const raw = `[THINK]I need to decode the JWT[/THINK]\nreturn jwt.decode(token, SECRET)`
  consola.log(parse(raw, template))

  consola.log("\n=== parse (qwen) ===")
  const rawQwen = `<think>reasoning here</think>\n<|im_start|>assistant\nreturn jwt.decode(token, SECRET)<|im_end|>`
  consola.log(parse(rawQwen, Profiles.qwen))
}
