import type { AnnotatedText } from './span'
import type { RenderContext } from './round'

export type RenderPass = (spans: AnnotatedText, ctx: RenderContext) => AnnotatedText

// --- extractionPass ---
// Spans tagged with meta.memoryKey: if the key still exists in memory,
// replace the span matching text with "[Extracted to $key]".
// If the key was deleted or overwritten, show the original text - always truthful.

export const extractionPass: RenderPass = (spans, ctx) =>
  spans.map(span => {
    const key = span.meta?.memoryKey
    if (!key) return span

    return ctx.memory.has(key)
      ? { ...span, text: `[Extracted to ${key}]` }
      : span  // key gone; original content visible again
  })

// --- reasoningPass ---
// age 0: keep reasoning spans (full fidelity, active context).
// age 1+: drop reasoning spans. Old reasoning is noise; model content is what matters.

export const reasoningPass: RenderPass = (spans, ctx) =>
  ctx.age === 0 ? spans : spans.filter(s => s.kind !== 'reasoning')

// --- truncationPass ---
// Operates on tool_result spans only.
// age 0: full. If span has a memoryKey and that key exists, show "[Stored as $key]".
// age 1: large results truncated; errors preserved in full.
// age 2+: structural skeleton (keys present, values collapsed to '').

const AGE1_CHAR_THRESHOLD = 1000  // chars above which results are truncated at age 1

export const truncationPass: RenderPass = (spans, ctx) =>
  spans.map(span => {
    if (span.kind !== 'tool_result') return span

    if (!span.meta?.truncatable) return span

    // If this result was auto-stored to memory, show the reference marker
    const storedKey = span.meta.memoryKey
    if (storedKey && ctx.memory.has(storedKey)) {
      return { ...span, text: `[Stored as ${storedKey}]` }
    }

    if (ctx.age === 0) return span  // full fidelity

    const isError = span.text.startsWith('ERROR:')

    if (ctx.age === 1) {
      if (isError) return span  // errors always preserved at age 1

      if (span.text.length > AGE1_CHAR_THRESHOLD) {
        return { ...span, text: span.text.slice(0, AGE1_CHAR_THRESHOLD) + '\n... (truncated)' }
      }

      return span
    }

    // age 2+: skeleton
    if (isError) return span  // errors survive even at age 2

    return { ...span, text: trySkeletonize(span.text) }
  })

function trySkeletonize(text: string): string {
  try {
    return JSON.stringify(collapseValues(JSON.parse(text)))

  } catch {
    return '(collapsed)'
  }
}

function collapseValues(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(collapseValues)

  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(val)) out[key] = ''

    return out
  }

  return ''
}

// --- joinPass ---
// Terminal pass. Collapses AnnotatedText to a plain string.
// Only called at the very end of the pipeline - never mid-pass.

export function joinPass(spans: AnnotatedText): string {
  return spans.map(s => s.text).join('')
}

// --- Ordered pipeline (pre-join) ---

export const pipeline: RenderPass[] = [
  extractionPass,
  reasoningPass,
  truncationPass,
]

/** Run all non-terminal passes. Returns AnnotatedText ready for joinPass. */
export function runPipeline(spans: AnnotatedText, ctx: RenderContext): AnnotatedText {
  return pipeline.reduce((s, pass) => pass(s, ctx), spans)
}
