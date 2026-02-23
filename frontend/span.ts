export type SpanKind =
  | 'reasoning'   // model think block content
  | 'content'     // user/model prose
  | 'tool_call'   // tool invocation text
  | 'tool_result' // tool response text
  | 'error'       // error message

export type Span = {
  text: string
  kind: SpanKind
  meta?: {
    truncatable?: boolean

    /** If set, extractionPass will elide this span when the key exists in memory. */
    memoryKey?: string

    /** Cached char count. Populated by FSM during ingest. Stub for tokenizer. */
    count?: number
    roundId?: string
  }
}

export type AnnotatedText = Span[]

// --- Char counting stubs ---
// Replace with tiktoken or equivalent later. Using character length for now.

export function countChars(text: string): number {
  return text.length
}

export function countSpanChars(spans: AnnotatedText): number {
  return spans.reduce((acc, s) => acc + s.text.length, 0)
}

// --- Span constructors ---

export function textSpan(text: string): Span {
  return { kind: 'content', text }
}

export function reasoningSpan(text: string): Span {
  return { kind: 'reasoning', text }
}

export function toolCallSpan(text: string): Span {
  return { kind: 'tool_call', text }
}

/** truncatable=true: this result may be compressed by truncationPass at age 1+. */
export function toolResultSpan(text: string, truncatable = true): Span {
  return { kind: 'tool_result', text, meta: { truncatable } }
}

export function errorSpan(text: string): Span {
  return { kind: 'error', text }
}

/**
 * A content span backed by a memory key.
 * extractionPass replaces matched text with "[Extracted to $key]" when the key exists.
 * If the key is gone (overwritten/deleted), the original text is shown.
 */
export function extractedSpan(text: string, memoryKey: string): Span {
  return { kind: 'content', text, meta: { memoryKey } }
}
