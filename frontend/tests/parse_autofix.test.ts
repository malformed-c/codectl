import { describe, expect, test } from 'bun:test'
import { parse, Profiles, turnContent, turnThink, turnToolCalls } from '../template'

const mistral = Profiles.mistral
const qwen = Profiles.qwen
const qwenXml = Profiles.qwenXml

describe('parse - think block autofix', () => {
  test('normal pair parses cleanly - no malformed flag', () => {
    const r = parse('[THINK]some thinking[/THINK]\nsome content', mistral)
    expect(turnThink(r)).toBe('some thinking')
    expect(turnContent(r)).toBe('some content')
    expect(r.malformed).toBeUndefined()
  })

  test('missing open: fixes by prepending [THINK]', () => {
    const r = parse('[/THINK]\nactual content', mistral)
    expect(turnThink(r)).toBe('')
    expect(turnContent(r)).toBe('actual content')
    expect(r.malformed).toBe(true)
  })

  test('missing open: text before close tag becomes think content', () => {
    // Model forgot [THINK] but included [/THINK] - everything before close is think
    const r = parse('some content [/THINK] more content', mistral)
    expect(turnThink(r)).toBe('some content')
    expect(turnContent(r)).toBe('more content')
    expect(r.malformed).toBe(true)
  })

  test('missing close: appends [/THINK] before [TOOL_CALLS]', () => {
    const raw = '[THINK]reasoning here\n[TOOL_CALLS][{"name":"bash","arguments":{"command":"id"}}]'
    const r = parse(raw, mistral)
    expect(turnThink(r)).toBe('reasoning here')
    expect(turnToolCalls(r)).toHaveLength(1)
    expect(r.malformed).toBe(true)
  })

  test('missing close: appends [/THINK] at EOF when no stop token', () => {
    const r = parse('[THINK]just thinking no tools', mistral)
    expect(turnThink(r)).toBe('just thinking no tools')
    expect(r.malformed).toBe(true)
    expect(turnContent(r)).toBe('')
  })

  test('missing close with content prefix: prefix becomes content, think is the think', () => {
    const r = parse('prefix text [THINK]thinking', mistral)
    expect(turnThink(r)).toBe('thinking')
    expect(r.malformed).toBe(true)
  })

  test('qwen think tag: normal pair parses correctly', () => {
    const r = parse('<think>reasoning</think>\nresponse', qwen)
    expect(turnThink(r)).toBe('reasoning')
    expect(turnContent(r)).toBe('response')
    expect(r.malformed).toBeUndefined()
  })

  test('qwen think tag: missing close runs content to EOF', () => {
    const r = parse('<think>reasoning without close', qwen)
    expect(turnThink(r)).toBe('reasoning without close')
    expect(r.malformed).toBe(true)
  })

  test('no think tag present - parses content normally', () => {
    const r = parse('just a response', mistral)
    expect(turnThink(r)).toBe('')
    expect(turnContent(r)).toBe('just a response')
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
    expect(turnToolCalls(r)).toHaveLength(1)
    expect(turnContent(r)).toBe('')
    expect(r.malformed).toBeUndefined()
  })

  test('content before tool calls is preserved', () => {
    const r = parse('I will run a command.\n[TOOL_CALLS][{"name":"bash","arguments":{"command":"ls"}}]', mistral)
    expect(turnContent(r)).toBe('I will run a command.')
    expect(turnToolCalls(r)).toHaveLength(1)
  })

  test('think + tool calls in same response', () => {
    const r = parse('[THINK]planning[/THINK]\nok [TOOL_CALLS][{"name":"bash","arguments":{"command":"id"}}]', mistral)
    expect(turnThink(r)).toBe('planning')
    expect(turnToolCalls(r)).toHaveLength(1)
    expect(turnContent(r)).toBe('ok')
  })
})

describe('parse - think closes before TOOL_CALLS when missing close', () => {
  test('missing [/THINK] followed by TOOL_CALLS: think stops at tool call boundary', () => {
    const raw = '[THINK]I need to call a tool\n[TOOL_CALLS][{"name":"tool_library","arguments":{"prefix":"extract"}}]'
    const r = parse(raw, mistral)
    expect(turnThink(r)).toBe('I need to call a tool')
    expect(turnToolCalls(r)).toHaveLength(1)
    expect(r.malformed).toBe(true)
    // Think content should NOT contain the tool call text
    expect(turnThink(r)).not.toContain('TOOL_CALLS')
    expect(turnThink(r)).not.toContain('tool_library')
  })
})

describe('parse - qwen XML tool calls', () => {
  test('parses inline xml tool calls with multiline parameters', () => {
    const raw = `<think>plan</think>
I will use a tool.
<tool_call>
<function=bash>
<parameter=command>
echo hello
world
</parameter>
<parameter=timeout>
10
</parameter>
</function>
</tool_call>`

    const r = parse(raw, qwenXml)
    expect(turnThink(r)).toBe('plan')
    expect(turnContent(r)).toBe('I will use a tool.')
    const calls = turnToolCalls(r)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('bash')
    expect(calls[0]!.arguments.command).toBe('echo hello\nworld')
    expect(calls[0]!.arguments.timeout).toBe(10)
  })
})

describe('parse - BOS/EOS stripping', () => {
  test('strips model turn wrapper if model echoed it', () => {
    // Mistral model turn is [INST]...[/INST] for user, </s> for model EOS
    const r = parse('Just a clean response', mistral)
    expect(turnContent(r)).toBe('Just a clean response')
  })
})
