import { describe, expect, test } from 'bun:test'
import { makeFormatPass, joinPass } from '../pipeline'
import { Profiles, parse, renderToolCalls } from '../template'
import { parseToolCalls } from '../tool'
import type { Span } from '../span'
import type { StoredToolCall } from '../types'

describe('mistral tool call round-trip stability', () => {
  test('keeps think + tool calls in one assistant wrapper without injected close token', () => {
    const formatPass = makeFormatPass(Profiles.mistral)
    const spans: Span[] = [
      { kind: 'reasoning', text: 'plan' },
      {
        kind: 'tool_call',
        text: '',
      },
    ]

    const out = joinPass(formatPass(spans, { age: 0, memory: new Map(), budget: 99999 }))
    expect(out).toBe('[THINK]plan[/THINK][TOOL_CALLS]bash[ARGS]{"command":"id"}</s>\n')
    expect(out).not.toContain('[/THINK]</s>\n[TOOL_CALLS]')
  })

  test('round-trips multiple rich tool calls preserving token order', () => {
    const raw = '[THINK]deliberate[/THINK][TOOL_CALLS]bash[CALL_ID]a1[ARGS]{"command":"w"}\nbash[CALL_ID]a2[ARGS]{"command":"id"}'
    const parsed = parse(raw, Profiles.mistral)

    expect(parsed.think).toBe('deliberate')
    expect(parsed.toolCalls).toHaveLength(1)

    const stored: StoredToolCall[] = parseToolCalls(parsed.toolCalls![0]!).map(call => ({
      tool: call.name,
      ...(call.callId ? { callId: call.callId } : {}),
      ...call.arguments,
    }))

    const rerendered = renderToolCalls(stored, Profiles.mistral)
    expect(rerendered).toBe('bash[CALL_ID]a1[ARGS]{"command":"w"}\nbash[CALL_ID]a2[ARGS]{"command":"id"}')
  })

  test('preserves formatted JSON args when raw payload is available', () => {
    const raw = 'bash[ARGS]{\n  "command": "echo hi",\n  "timeout": 10\n}'
    const parsedCall = parseToolCalls(raw)[0]!
    const stored: StoredToolCall = {
      tool: parsedCall.name,
      ...parsedCall.arguments,
    }

    const rerendered = renderToolCalls([stored], Profiles.mistral)
    expect(rerendered).toBe(raw)
  })
})
