import type { AnnotatedText, Span, SpanKind } from './span'
import type { RenderContext } from './round'
import type { TextTemplate, ToolCallsTemplate, ToolResultsTemplate } from './template'
import { renderToolCalls, renderStoredToolResults, wrapContent, resolveWrap } from './template'
import type { StoredToolCall, StoredToolResult } from './types'

export type RenderPass = (spans: AnnotatedText, ctx: RenderContext) => AnnotatedText

// --- extractionPass ---
// Spans tagged with meta.memoryKey: look up the value stored at that key in memory,
// then replace only the matching substring within the span's text.
// This preserves any surrounding text in the span (e.g. punctuation, wrapping prose).
// If the key is gone (overwritten/deleted), the original span is returned unchanged -
// always truthful: what's not in memory is shown in full.

export const extractionPass: RenderPass = (spans, ctx) =>
  spans.map(span => {
    const key = span.meta?.memoryKey

    if (!key) return span

    const value = ctx.memory.get(key)

    if (value === undefined) return span  // key gone; original content visible again

    // Replace all occurrences of the stored value within this span's text.
    // A span might contain the extracted block more than once (unlikely but safe).
    const marker = `[Extracted to ${key}]`
    const replaced = span.text.replaceAll(value, marker)

    // If the value wasn't found in the text (span already elided or key mismatch),
    // return as-is rather than corrupting the span.
    if (replaced === span.text) return span

    return { ...span, text: replaced }
  })

// --- reasoningPass ---
// age 0: keep reasoning spans (full fidelity, active context).
// age 1+: drop reasoning spans. Old reasoning is noise; model content is what matters.

export const reasoningPass: RenderPass = (spans, ctx) =>
  ctx.age === 0 ? spans : spans.filter(s => s.kind !== 'reasoning')

// --- truncationPass ---
// Operates on tool_result spans only, using meta.results (structured) when present.
// Modifies both meta.results (for formatPass) and span.text (fallback).
//
// age 0: full. If span has a memoryKey and key exists, show "[Stored as $key]".
// age 1: truncate large result values; errors always preserved in full.
// age 2+: structural skeleton - keys present, values collapsed to ''.

const AGE1_CHAR_THRESHOLD = 1000  // chars above which results are truncated at age 1

export const truncationPass: RenderPass = (spans, ctx) =>
  spans.map(span => {
    if (span.kind !== 'tool_result') return span

    if (!span.meta?.truncatable) return span

    // If auto-stored to memory, show reference marker (formatPass will not re-render this)
    const storedKey = span.meta.memoryKey

    if (storedKey && ctx.memory.has(storedKey)) {
      return { ...span, text: `[Stored as ${storedKey}]`, meta: { ...span.meta, results: undefined } }
    }

    if (ctx.age === 0) return span  // full fidelity

    const results = span.meta.results
    const hasError = results?.some(r => r.error) ?? span.text.startsWith('ERROR:')

    if (ctx.age === 1) {
      if (hasError) return span  // errors always preserved at age 1

      if (results) {
        const totalChars = results.reduce((acc, r) => acc + JSON.stringify(r.value ?? '').length, 0)

        if (totalChars <= AGE1_CHAR_THRESHOLD) return span

        const perItemLimit = Math.max(100, Math.floor(AGE1_CHAR_THRESHOLD / Math.max(1, results.length)))
        const truncated = results.map(r => {
          if (r.error) return r

          const serialized = typeof r.value === 'string' ? r.value : JSON.stringify(r.value)

          return serialized.length > perItemLimit
            ? { ...r, value: serialized.slice(0, perItemLimit) + '... (truncated)' }
            : r
        })

        return withResults(span, truncated)
      }

      // Fallback: raw text truncation (no structured meta)
      return span.text.length > AGE1_CHAR_THRESHOLD
        ? { ...span, text: span.text.slice(0, AGE1_CHAR_THRESHOLD) + '\n... (truncated)' }
        : span
    }

    // age 2+: skeleton
    if (hasError) return span  // errors survive at age 2

    if (results) {
      const skeletonized = results.map(r =>
        r.error ? r : { ...r, value: collapseValues(r.value) }
      )

      return withResults(span, skeletonized)
    }

    return { ...span, text: trySkeletonizeText(span.text) }
  })

/** Produce a new span with updated results[] and re-serialized text fallback. */
function withResults(span: Span, results: StoredToolResult[]): Span {
  const text = results.map(r =>
    r.error
      ? `ERROR: ${r.error}`
      : (typeof r.value === 'string' ? r.value : JSON.stringify(r.value))
  ).join('\n')

  return { ...span, text, meta: { ...span.meta, results } }
}

function trySkeletonizeText(text: string): string {
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

// --- formatPass ---
// Template-aware pass. Groups consecutive same-family spans and wraps each group
// with the correct template tokens. Must run AFTER all compression passes and
// BEFORE joinPass.
//
// Turn families:
//   'reasoning' + 'model' -> one modelTurn (think nested inside)
//   'user'                -> userTurn
//   'tool_call'           -> toolCall template (uses meta.calls for rich rendering)
//   'tool_result'         -> toolResult template (uses meta.results for rich rendering)
//   'system' | 'error'   -> system template (or plain prepend if template has none)

type TurnFamily = 'model' | 'user' | 'tool_call' | 'tool_result' | 'system'

function toFamily(kind: SpanKind): TurnFamily {
  if (kind === 'reasoning') return 'model'

  if (kind === 'system' || kind === 'error') return 'system'

  return kind as TurnFamily
}

export function makeFormatPass(template: TextTemplate): RenderPass {
  return (spans, _ctx) => {
    if (spans.length === 0) return spans

    // Group consecutive spans by turn family
    const groups: { family: TurnFamily; spans: Span[] }[] = []

    for (const span of spans) {
      const family = toFamily(span.kind)
      const last = groups.at(-1)

      if (last && last.family === family) {
        last.spans.push(span)

      } else {
        groups.push({ family, spans: [span] })
      }
    }

    // Some templates place tool calls inside assistant output (same role turn),
    // e.g. Mistral rich format. Merge adjacent model + tool_call groups so they
    // are rendered in one assistant wrapper and token order remains stable.
    const assistantInlineToolCalls = Boolean(
      template.toolCall
      && !Array.isArray(template.toolCall)
      && template.toolCall.wrap[1] === ''
    )

    const mergedGroups: { family: TurnFamily; spans: Span[] }[] = []

    for (const group of groups) {
      const prev = mergedGroups.at(-1)

      if (
        assistantInlineToolCalls
        && prev
        && prev.family === 'model'
        && group.family === 'tool_call'
      ) {
        prev.spans.push(...group.spans)

      } else {
        mergedGroups.push({ family: group.family, spans: [...group.spans] })
      }
    }

    const out: AnnotatedText = []

    for (const { family, spans: group } of mergedGroups) {
      const first = group[0]!

      if (family === 'user') {
        const text = group.map(s => s.text).join('')
        out.push({ ...first, text: wrapContent(template.userTurn, text) })

      } else if (family === 'model') {
        const reasoning = group.filter(s => s.kind === 'reasoning')
        const model = group.filter(s => s.kind === 'model')
        const toolCallSpans = group.filter(s => s.kind === 'tool_call')

        // Reasoning is nested inside modelTurn using the think template
        const thinkPart = reasoning.length > 0 && template.think
          ? wrapContent(template.think, reasoning.map(s => s.text).join(''))
          : reasoning.map(s => s.text).join('')  // no think token: inline

        const modelPart = model.map(s => s.text).join('')
        const toolCalls = toolCallSpans.flatMap(s => s.meta?.calls ?? [])
        const toolCallPart = toolCallSpans.length > 0
          ? wrapContent(resolveWrap(template.toolCall, template.modelTurn), toolCalls.length
            ? renderToolCalls(toolCalls, template)
            : toolCallSpans.map(s => s.text).join(''))
          : ''

        out.push({ ...first, text: wrapContent(template.modelTurn, thinkPart + modelPart + toolCallPart) })

      } else if (family === 'tool_call') {
        // Use meta.calls for template-correct rendering (Mistral rich format, etc.)
        const calls = group.flatMap(s => s.meta?.calls ?? [])
        const inner = calls.length
          ? renderToolCalls(calls, template)
          : group.map(s => s.text).join('')

        const pair = resolveWrap(template.toolCall, template.modelTurn)
        out.push({ ...first, text: wrapContent(pair, inner) })

      } else if (family === 'tool_result') {
        // Use meta.results for template-correct rendering (already truncated/skeletonized)
        const results = group.flatMap(s => s.meta?.results ?? [])
        const inner = results.length
          ? renderStoredToolResults(results, template)
          : group.map(s => s.text).join('')

        const pair = resolveWrap(template.toolResult, template.userTurn)
        out.push({ ...first, text: wrapContent(pair, inner) })

      } else {
        // system / error
        const text = group.map(s => s.text).join('')
        const formatted = template.system
          ? wrapContent(template.system, text)
          : text + '\n\n'  // no system token: prepend as plain text

        out.push({ ...first, text: formatted })
      }
    }

    return out
  }
}

// --- joinPass ---
// Terminal pass. Collapses AnnotatedText to a plain string.
// Only called at the very end of the pipeline - never mid-pass.

export function joinPass(spans: AnnotatedText): string {
  return joinWithBoundaryNormalization(spans.map(s => s.text))
}

/**
 * Join pre-rendered parts while collapsing only duplicated newline runs at part boundaries.
 *
 * This is intentionally boundary-scoped (never global whitespace collapse) so content
 * inside parts (e.g. code blocks, JSON, tool payloads) is preserved byte-for-byte.
 */
export function joinWithBoundaryNormalization(parts: string[]): string {
  if (parts.length === 0) return ''

  let out = parts[0]!

  for (let i = 1; i < parts.length; i++) {
    out = joinBoundary(out, parts[i]!)
  }

  return out
}

function joinBoundary(left: string, right: string): string {
  if (!left || !right) return left + right

  const trailing = countTrailingNewlines(left)
  const leading = countLeadingNewlines(right)

  if (trailing === 0 || leading === 0) return left + right

  // Keep the stronger side's newline run and remove only boundary overlap.
  const keep = Math.max(trailing, leading)

  return `${left.slice(0, left.length - trailing)}${'\n'.repeat(keep)}${right.slice(leading)}`
}

function countTrailingNewlines(text: string): number {
  let i = text.length - 1

  while (i >= 0 && text[i] === '\n') i--

  return text.length - 1 - i
}

function countLeadingNewlines(text: string): number {
  let i = 0

  while (i < text.length && text[i] === '\n') i++

  return i
}

// --- Pipeline builder ---
//
// Two-stage pipeline:
//
//   COMPRESSION_PIPELINE (cacheable):
//     reasoningPass + truncationPass only.
//     Output is safe to cache: depends only on age, never on memory state.
//     extractionPass is intentionally excluded - caching extracted text would
//     destroy original span content, making key deletion/overwrite irrecoverable.
//
//   extractionPass (always fresh):
//     Applied at read time after cache retrieval. Never stored in the cache.
//     Operates on original span text so key changes are always reflected correctly.
//
//   formatPass (always fresh):
//     Applied after extraction. Template-aware; not worth caching.

export const COMPRESSION_PIPELINE: RenderPass[] = [
  reasoningPass,
  truncationPass,
]

/** Run only the compression passes. Output is safe to cache (age-keyed only). */
export function runCompressionPipeline(spans: AnnotatedText, ctx: RenderContext): AnnotatedText {
  return COMPRESSION_PIPELINE.reduce((s, pass) => pass(s, ctx), spans)
}

/**
 * Run the full pipeline: compression -> extraction -> format.
 * Extraction and format are applied fresh - not cached.
 */
export function runPipeline(spans: AnnotatedText, template: TextTemplate, ctx: RenderContext): AnnotatedText {
  const compressed = runCompressionPipeline(spans, ctx)
  const extracted = extractionPass(compressed, ctx)

  return makeFormatPass(template)(extracted, ctx)
}
