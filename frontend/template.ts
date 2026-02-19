// --- Types ---

import { match, P } from 'ts-pattern'

type TemplatePair = [open: string, close: string]

export type FimTemplate = {
  prefix: string
  middle: string
  suffix: string
}

type ToolCallsTemplate = {
  wrap: TemplatePair            // [TOOL_CALLS] ... (outer)

  // Mistral
  rich?: {
    callId: string             // [CALL_ID] - precedes the call id
    args: string               // [ARGS] - precedes arguments
  }
}

type ToolResultsTemplate = {
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

export type Message = {
  role: Role
  content: string
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
      .with({ role: 'assistant' }, { role: 'model' }, ({ content }) =>
        wrapPair(template.modelTurn, content)
      )
      .with({ role: 'tool_result' }, ({ content }) =>
        wrapPair(resolveWrap(template.toolResult, template.userTurn), content)
      )
      .with({ role: 'tool_call' }, ({ content }) =>
        wrapPair(resolveWrap(template.toolCall, template.modelTurn), content)
      )
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

// --- Parser ------

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
      results.push(text.slice(contentStart).trim())

      break
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
  if (!close) return text.replaceAll(open, '')

  let result = text
  while (true) {
    const start = result.indexOf(open)
    if (start === -1) break

    const end = result.indexOf(close, start + open.length)
    if (end === -1) {
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

  console.log("=== render ===")
  console.log(render(messages, template))

  console.log("\n=== renderFim ===")
  console.log(renderFim({
    prefix: "def verify_token(token: str) -> dict:\n    ",
    suffix: "\n\ndef login(): pass",
  }, template))

  console.log("\n=== parse (mistral) ===")
  const raw = `[THINK]I need to decode the JWT[/THINK]\nreturn jwt.decode(token, SECRET)`
  console.log(parse(raw, template))

  console.log("\n=== parse (qwen) ===")
  const rawQwen = `<think>reasoning here</think>\n<|im_start|>assistant\nreturn jwt.decode(token, SECRET)<|im_end|>`
  console.log(parse(rawQwen, Profiles.qwen))
}

