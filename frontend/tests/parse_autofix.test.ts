import { describe, expect, test } from 'bun:test'
import { parse, Profiles } from '../template'

const mistral = Profiles.mistral
const qwen = Profiles.qwen

describe('parse - think block autofix', () => {
  test('normal pair parses cleanly - no malformed flag', () => {
    const r = parse('[THINK]some thinking[/THINK]\nsome content', mistral)
    expect(r.think).toBe('some thinking')
    expect(r.content).toBe('some content')
    expect(r.malformed).toBeUndefined()
  })

  test('missing open: fixes by prepending [THINK]', () => {
    const r = parse('[/THINK]\nactual content', mistral)
    expect(r.think).toBe('')
    expect(r.content).toBe('actual content')
    expect(r.malformed).toBe(true)
  })

  test('missing open: text before close tag becomes think content', () => {
    // Model forgot [THINK] but included [/THINK] - everything before close is think
    const r = parse('some content [/THINK] more content', mistral)
    expect(r.think).toBe('some content')
    expect(r.content).toBe('more content')
    expect(r.malformed).toBe(true)
  })

  test('missing close: appends [/THINK] before [TOOL_CALLS]', () => {
    const raw = '[THINK]reasoning here\n[TOOL_CALLS][{"name":"bash","arguments":{"command":"id"}}]'
    const r = parse(raw, mistral)
    expect(r.think).toBe('reasoning here')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.malformed).toBe(true)
  })

  test('missing close: appends [/THINK] at EOF when no stop token', () => {
    const r = parse('[THINK]just thinking no tools', mistral)
    expect(r.think).toBe('just thinking no tools')
    expect(r.malformed).toBe(true)
    expect(r.content).toBe('')
  })

  test('missing close with content prefix: prefix becomes content, think is the think', () => {
    const r = parse('prefix text [THINK]thinking', mistral)
    expect(r.think).toBe('thinking')
    expect(r.malformed).toBe(true)
  })

  test('qwen think tag: normal pair parses correctly', () => {
    const r = parse('<think>reasoning</think>\nresponse', qwen)
    expect(r.think).toBe('reasoning')
    expect(r.content).toBe('response')
    expect(r.malformed).toBeUndefined()
  })

  test('qwen think tag: missing close runs content to EOF', () => {
    const r = parse('<think>reasoning without close', qwen)
    expect(r.think).toBe('reasoning without close')
    expect(r.malformed).toBe(true)
  })

  test('no think tag present - parses content normally', () => {
    const r = parse('just a response', mistral)
    expect(r.think).toBeUndefined()
    expect(r.content).toBe('just a response')
    expect(r.malformed).toBeUndefined()
  })

  test('both open and close present - no fix applied', () => {
    const r = parse('[THINK]plan[/THINK]\ndo the thing', mistral)
    expect(r.malformed).toBeUndefined()
  })
})

describe('parse - tool call autofix (Mistral)', () => {
  test('well-formed tool calls parse correctly', () => {
    const r = parse('[TOOL_CALLS][{"name":"bash","arguments":{"command":"ls"}}]', mistral)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.content).toBe('')
    expect(r.malformed).toBeUndefined()
  })

  test('content before tool calls is preserved', () => {
    const r = parse('I will run a command.\n[TOOL_CALLS][{"name":"bash","arguments":{"command":"ls"}}]', mistral)
    expect(r.content).toBe('I will run a command.')
    expect(r.toolCalls).toHaveLength(1)
  })

  test('think + tool calls in same response', () => {
    const r = parse('[THINK]planning[/THINK]\nok [TOOL_CALLS][{"name":"bash","arguments":{"command":"id"}}]', mistral)
    expect(r.think).toBe('planning')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.content).toBe('ok')
  })
})

describe('parse - think closes before TOOL_CALLS when missing close', () => {
  test('missing [/THINK] followed by TOOL_CALLS: think stops at tool call boundary', () => {
    const raw = '[THINK]I need to call a tool\n[TOOL_CALLS][{"name":"tool_library","arguments":{"prefix":"extract"}}]'
    const r = parse(raw, mistral)
    expect(r.think).toBe('I need to call a tool')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.malformed).toBe(true)
    // Think content should NOT contain the tool call text
    expect(r.think).not.toContain('TOOL_CALLS')
    expect(r.think).not.toContain('tool_library')
  })
})

describe('parse - BOS/EOS stripping', () => {
  test('strips model turn wrapper if model echoed it', () => {
    // Mistral model turn is [INST]...[/INST] for user, </s> for model EOS
    const r = parse('Just a clean response', mistral)
    expect(r.content).toBe('Just a clean response')
  })
})
