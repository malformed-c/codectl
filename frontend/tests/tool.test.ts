import { describe, expect, test } from 'bun:test'
import { parseToolCalls, resolveArgs } from '../tool'
import { BashTool } from '../tools/exec'

describe('parseToolCalls', () => {
  test('parses rich call with JSON args', () => {
    const calls = parseToolCalls('bash[ARGS]{"command":"w"}')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      name: 'bash',
      arguments: { command: 'w' },
    })
  })

  test('parses rich shorthand args as value and resolves to required param', () => {
    const calls = parseToolCalls('bash[ARGS]w')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual({ value: 'w' })

    const resolved = resolveArgs(calls[0]!.arguments, BashTool)
    expect(resolved).toEqual({ command: 'w' })
  })

  test('parses multiple rich tool calls from one block', () => {
    const raw = 'bash[ARGS]w\nbash[ARGS]id'
    const calls = parseToolCalls(raw)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      name: 'bash',
      arguments: { value: 'w' },
    })
    expect(calls[1]).toEqual({
      name: 'bash',
      arguments: { value: 'id' },
    })
  })
})
