import { describe, expect, test } from 'bun:test'
import { makeFormatPass, joinPass } from '../pipeline'
import { Profiles, parse, render, renderToolCalls, turnContent, turnThink, turnToolCalls } from '../template'
import type { Span } from '../span'
import type { StoredToolCall } from '../types'

describe('mistral tool call round-trip stability', () => {
  test('renders think + tool calls in one assistant wrapper', () => {
    const formatPass = makeFormatPass(Profiles.mistral)

    const storedCall: StoredToolCall = { tool: 'bash', command: 'id' }
    const spans: Span[] = [
      { kind: 'reasoning', text: 'plan' },
      {
        kind: 'tool_call',
        text: 'bash[ARGS]{"command":"id"}',
        meta: { calls: [storedCall] },
      },
    ]

    const out = joinPass(formatPass(spans, { age: 0, memory: new Map(), budget: 99999 }))
    // think + tool_call merged into one model turn wrapper for Mistral
    expect(out).toContain('[THINK]plan[/THINK]')
    expect(out).toContain('[TOOL_CALLS]')
    expect(out).toContain('bash')
    // They should NOT be in separate wrappers
    expect(out).not.toMatch(/\[\/THINK\]<\/s>[\s\S]*\[TOOL_CALLS\]/)
  })

  test('round-trips multiple rich tool calls preserving token order', () => {
    const raw = '[THINK]deliberate[/THINK][TOOL_CALLS]bash[CALL_ID]a1[ARGS]{"command":"w"}\nbash[CALL_ID]a2[ARGS]{"command":"id"}'
    const parsed = parse(raw, Profiles.mistral)

    expect(turnThink(parsed)).toBe('deliberate')
    // Both bash calls become individual tool_call steps
    const calls = turnToolCalls(parsed)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.name).toBe('bash')
    expect(calls[0]!.callId).toBe('a1')
    expect(calls[1]!.callId).toBe('a2')

    const stored: StoredToolCall[] = calls.map(c => ({
      tool: c.name,
      ...(c.callId ? { callId: c.callId } : {}),
      ...c.arguments,
    }))

    const rerendered = renderToolCalls(stored, Profiles.mistral)
    expect(rerendered).toBe('bash[CALL_ID]a1[ARGS]{"command":"w"}\nbash[CALL_ID]a2[ARGS]{"command":"id"}')
  })

  test('renders compact JSON args (no pretty-printing in model context)', () => {
    const stored: StoredToolCall = { tool: 'bash', command: 'echo hi', timeout: 10 }
    const rerendered = renderToolCalls([stored], Profiles.mistral)
    // Compact JSON - no newlines/indentation in model prompt
    expect(rerendered).toBe('bash[ARGS]{"command":"echo hi","timeout":10}')
    expect(rerendered).not.toContain('\n  ')
  })
})

describe('qwen xml tool call rendering', () => {
  test('renders xml function + parameter blocks', () => {
    const stored: StoredToolCall = { tool: 'bash', command: 'ls -la', timeout: 3 }
    const rerendered = renderToolCalls([stored], Profiles.qwenXml)

    expect(rerendered).toContain('<tool_call>')
    expect(rerendered).toContain('<function=bash>')
    expect(rerendered).toContain('<parameter=command>')
    expect(rerendered).toContain('ls -la')
    expect(rerendered).toContain('<parameter=timeout>')
    expect(rerendered).toContain('3')
  })

  test('renders tool results with toolTurn wrapper + tool_response body', () => {
    const prompt = render([
      { role: 'tool_result', content: 'ok' },
    ], Profiles.qwenXml)

    expect(prompt).toContain('<|im_start|>tool\n<tool_response>\nok\n</tool_response><|im_end|>\n')
  })
})
