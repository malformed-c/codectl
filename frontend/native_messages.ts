/**
 * Converts the orchestrator's Round history into a flat Message[] array
 * suitable for native LLM APIs (Gemini, OpenAI function calling).
 *
 * Bypasses the template/renderHistory pipeline entirely — no tool blocks
 * baked into text, no [INST] tags, just structured role/content messages
 * with tool calls and results as first-class fields.
 */

import type { Message } from './template'
import type { Round } from './round'
import type { SerializedRound } from './round'
import type { Span } from './span'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a Message[] from the orchestrator's system prompt + round history.
 * Pass `this._enrichedSystemRound` as the first round, followed by
 * `this.fsm.getRenderableHistory()`.
 */
export function roundsToMessages(rounds: Round[], systemPrompt: string): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]

  for (const round of rounds) {
    flattenRound(round.serialize(), messages)
  }

  return messages
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function flattenRound(s: SerializedRound, out: Message[]): void {
  switch (s.kind) {
    case 'system':
      // Inject as system message (mode changes, think-only corrections, etc.)
      out.push({ role: 'system', content: s.message })
      break

    case 'chat':
      // Simple user/model exchange
      out.push({ role: 'user', content: spansText(s.user) })
      if (s.model) out.push({ role: 'assistant', content: s.model })
      break

    case 'agent':
      // Trigger user message, then tool loop children, then final model response
      out.push({ role: 'user', content: spansText(s.trigger) })
      for (const child of s.rounds) flattenRound(child, out)
      if (s.response) out.push({ role: 'assistant', content: s.response })
      break

    case 'tool': {
      // Assistant message with function calls
      if (s.calls.length) {
        out.push({
          role: 'assistant',
          content: s.content ?? '',
          calls: s.calls,
        })
      }

      // Tool result message.
      // We store `calls` alongside `results` so adapters can pair them by
      // index to recover the tool name (needed for functionResponse in Gemini).
      if (s.results.length) {
        out.push({
          role: 'tool_result',
          content: '',
          calls: s.calls,   // parallel to results[] — same length
          results: s.results,
        })
      }
      break
    }

    case 'error':
      out.push({ role: 'system', content: `[Error] ${s.message}` })
      break
  }
}

function spansText(spans: Span[]): string {
  return spans
    .filter(s => s.kind === 'user' || s.kind === 'content' || s.kind === 'text' as string)
    .map(s => s.text)
    .join('')
    || spans.map(s => s.text).join('')  // fallback: join all if filter yields nothing
}
