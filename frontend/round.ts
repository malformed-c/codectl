import type { AnnotatedText, Span } from './span'
import {
  modelSpan, reasoningSpan,
  toolCallSpan, toolResultSpan,
  systemSpan, errorSpan,
  countSpanChars,
} from './span'
import type { TextTemplate } from './template'
import type { StoredToolCall, StoredToolResult } from './types'

// --- RenderContext ---

export type RenderContext = {
  age: number                          // 0 = newest, 1 = mid, 2 = old, 3 = trim
  memory: ReadonlyMap<string, string>
  budget: number                       // total char budget for the whole prompt
}

// --- Round interface ---

export interface Round {
  readonly id: string

  /**
   * Returns annotated spans for pipeline processing.
   * Do NOT join to string here - pipeline passes transform Span[].
   */
  spans(ctx: RenderContext): AnnotatedText

  /**
   * Cached total character count, populated by Pass 1 after ingest.
   * Pass 2 uses this to assign ages without re-rendering.
   * Mutable so Pass 1 can stamp it after ingest.
   */
  count: number

  serialize(): SerializedRound
}

// --- Serialized AST types ---

export type SerializedRound =
  | { kind: 'chat'; id: string; user: Span[]; reasoning?: string; model: string }
  | { kind: 'agent'; id: string; rounds: SerializedRound[] }
  | { kind: 'tool'; id: string; reasoning?: string; content?: string; calls: StoredToolCall[]; results: StoredToolResult[] }
  | { kind: 'system'; id: string; message: string }
  | { kind: 'error'; id: string; message: string; input?: string }

// --- ID generation ---

let _counter = 0
function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++_counter}`
}

// --- Round factories ---

/**
 * One user/model exchange.
 * userSpans may contain extractedSpan() entries - extractionPass elides them at render time.
 */
export function chatRound(
  userSpans: Span[],
  modelText: string,
  reasoning?: string,
): Round {
  const id = newId('chat')
  let count = countSpanChars(userSpans) + modelText.length + (reasoning?.length ?? 0)

  return {
    id,
    get count() { return count },
    set count(v: number) { count = v },

    spans(ctx: RenderContext): AnnotatedText {
      const out: AnnotatedText = []

      // User content (may include extractedSpan entries; extractionPass handles them)
      out.push(...userSpans)

      // Reasoning (reasoningPass drops at age 1+)
      if (reasoning) out.push(reasoningSpan(reasoning))

      // Model response
      if (modelText) out.push(modelSpan(modelText))

      return out
    },

    serialize(): SerializedRound {
      return { kind: 'chat', id, user: userSpans, reasoning, model: modelText }
    },
  }
}

/**
 * Container for an autonomous agent run.
 * Children are ToolRounds, ErrorRounds, SystemRounds, or nested AgentRounds.
 * Compression policy lives here - not in individual children.
 */
export function agentRound(children: Round[]): Round {
  const id = newId('agent')
  let count = children.reduce((acc, r) => acc + r.count, 0)

  return {
    id,
    get count() { return count },
    set count(v: number) { count = v },

    spans(ctx: RenderContext): AnnotatedText {
      if (ctx.age === 0) {
        // Full fidelity: all children at their own ages
        return children.flatMap(c => c.spans(ctx))
      }

      if (ctx.age === 1) {
        // Last 3 children at age 1 (drop deep history within the agent run)
        return children.slice(-3).flatMap(c => c.spans({ ...ctx, age: 1 }))
      }

      // age 2+: only the last child's output (done result or fallback)
      // This policy handles ungraceful exits correctly - always the last committed result.
      const last = children.at(-1)
      if (!last) return []

      return last.spans({ ...ctx, age: 2 })
    },

    serialize(): SerializedRound {
      return { kind: 'agent', id, rounds: children.map(c => c.serialize()) }
    },
  }
}

/**
 * Leaf node: one batch of tool calls and their paired results.
 * FSM enforces strict call->result pairing; malformed sequences become ErrorRounds.
 */
export function toolRound(
  calls: StoredToolCall[],
  results: StoredToolResult[],
  reasoning?: string,
  content?: string,
): Round {
  const id = newId('tool')

  const renderCalls = (): string =>
    calls.map(c => {
      const { tool, callId, ...args } = c
      const argStr = JSON.stringify(args)

      return callId ? `${tool}[${callId}] ${argStr}` : `${tool} ${argStr}`
    }).join('\n')

  const renderResults = (): string =>
    results.map(r => {
      if (r.error) return `ERROR: ${r.error}`

      return typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
    }).join('\n')

  const callText = renderCalls()
  const resultText = renderResults()

  let count = (reasoning?.length ?? 0) + (content?.length ?? 0) + callText.length + resultText.length

  return {
    id,
    get count() { return count },
    set count(v: number) { count = v },

    spans(_ctx: RenderContext): AnnotatedText {
      const out: AnnotatedText = []

      if (reasoning) out.push(reasoningSpan(reasoning))
      if (content) out.push(modelSpan(content))

      out.push(toolCallSpan(calls, callText))
      out.push(toolResultSpan(results, resultText))

      return out
    },

    serialize(): SerializedRound {
      return { kind: 'tool', id, reasoning, content, calls, results }
    },
  }
}

/** Explicit orchestrator intervention (forced exit, mode switch, correction injection). */
export function systemRound(message: string): Round {
  const id = newId('system')
  let count = message.length

  return {
    id,
    get count() { return count },
    set count(v: number) { count = v },

    spans(ctx: RenderContext): AnnotatedText {
      // age 2+: transient orchestrator state is irrelevant to deep memory
      if (ctx.age >= 2) return []

      return [systemSpan(message)]
    },

    serialize(): SerializedRound {
      return { kind: 'system', id, message }
    },
  }
}

/**
 * Explicit model failure: malformed JSON, FSM transition violation.
 * Preserved in context so the model sees its mistake and can correct it.
 */
export function errorRound(message: string, input?: string): Round {
  const id = newId('error')
  let count = message.length + (input?.length ?? 0)

  return {
    id,
    get count() { return count },
    set count(v: number) { count = v },

    spans(ctx: RenderContext): AnnotatedText {
      if (ctx.age >= 2) return []  // drop from deep history

      const text = input ? `${message}\n\nInput that caused this error:\n${input}` : message

      return [errorSpan(text)]
    },

    serialize(): SerializedRound {
      return { kind: 'error', id, message, input }
    },
  }
}

// --- Deserializer ---

export function fromJSON(data: SerializedRound): Round {
  switch (data.kind) {
    case 'chat':
      return chatRound(data.user, data.model, data.reasoning)

    case 'agent':
      return agentRound(data.rounds.map(fromJSON))

    case 'tool':
      return toolRound(data.calls, data.results, data.reasoning, data.content)

    case 'system':
      return systemRound(data.message)

    case 'error':
      return errorRound(data.message, data.input)
  }
}

export type History = Round[]
