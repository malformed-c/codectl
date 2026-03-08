import { describe, expect, test } from 'bun:test'
import { Orchestrator, toPromise } from '../orchestrator'
import { Profiles, makeTurn, turnContent } from '../template'
import { KoboldAdapter } from '../kobold'
import { GeminiNativeAdapter, GeminiInteractionsAdapter } from '../gemini'
import { ModelRouter } from '../llm/router'
import type { ParsedTurn, Message } from '../template'
import type { ToolDefinition } from '../tool'

// ---------------------------------------------------------------------------
// Mock native adapter
// Simulates supportsNativeTools=true — records what messages+tools it receives.
// Does NOT extend KoboldAdapter since generate() is not part of that interface.
// ---------------------------------------------------------------------------

class MockNativeAdapter {
  readonly supportsNativeTools = true
  private index = 0
  readonly calls: Array<{ messages: Message[]; tools?: ToolDefinition[] }> = []

  constructor(private readonly turns: ParsedTurn[]) {}

  async generate(messages: Message[], tools?: ToolDefinition[]): Promise<ParsedTurn> {
    this.calls.push({ messages: [...messages], tools })
    const turn = this.turns[this.index] ?? this.turns[this.turns.length - 1]!
    this.index++
    return turn
  }

  async generateRaw(_prompt: string): Promise<ParsedTurn> {
    throw new Error('generateRaw should not be called for native adapter')
  }

  async status() { return { model: 'mock' } }
}

// ---------------------------------------------------------------------------
// Orchestrator native path branching
// ---------------------------------------------------------------------------

describe('Orchestrator native path (supportsNativeTools)', () => {
  test('calls generate(messages, tools) instead of generateRaw', async () => {
    const adapter = new MockNativeAdapter([
      makeTurn({ content: 'Hello from native!' }),
    ])

    const orch = new Orchestrator({ adapter: adapter as any })
    const result = await toPromise(orch.chat('Hi'))

    expect(turnContent(result.turn)).toBe('Hello from native!')
    expect(adapter.calls).toHaveLength(1)
    // First message should be system prompt
    expect(adapter.calls[0]!.messages[0]!.role).toBe('system')
    // Last message should be user input
    const msgs = adapter.calls[0]!.messages
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', content: 'Hi' })
  })

  test('passes registered tools to generate()', async () => {
    const adapter = new MockNativeAdapter([
      makeTurn({ content: 'Done.' }),
    ])

    const orch = new Orchestrator({ adapter: adapter as any })
    // mode and done tools are always registered; register one more
    orch.registerTool(
      { name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: {} } },
      async () => ({ ok: true, value: 'ok' } as any),
    )

    await toPromise(orch.chat('Do something'))

    const toolNames = adapter.calls[0]!.tools?.map(t => t.name) ?? []
    expect(toolNames).toContain('test_tool')
  })

  test('tool call round-trip: model calls tool, result fed back as tool_result message', async () => {
    const adapter = new MockNativeAdapter([
      makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'agent' } }] }),
      makeTurn({ content: 'Switched.' }),
    ])

    const orch = new Orchestrator({ adapter: adapter as any })
    const result = await toPromise(orch.chat('Switch to agent mode'))

    expect(result.toolsExecuted).toHaveLength(1)
    expect(result.toolsExecuted[0]!.call.name).toBe('mode')
    expect(orch.getMode().kind).toBe('agent')

    // Second generate() call should include tool_result message in history
    expect(adapter.calls).toHaveLength(2)
    const secondCallMsgs = adapter.calls[1]!.messages
    const hasToolResult = secondCallMsgs.some(m => m.role === 'tool_result')
    expect(hasToolResult).toBe(true)
  })

  test('system messages are included in native path', async () => {
    const adapter = new MockNativeAdapter([
      makeTurn({ content: 'Hi!' }),
    ])

    const orch = new Orchestrator({ adapter: adapter as any })
    await toPromise(orch.chat('Hello'))

    const systemMsg = adapter.calls[0]!.messages.find(m => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.content.length).toBeGreaterThan(0)
  })

  test('multi-turn: second message includes prior chat history', async () => {
    const adapter = new MockNativeAdapter([
      makeTurn({ content: 'First response.' }),
      makeTurn({ content: 'Second response.' }),
    ])

    const orch = new Orchestrator({ adapter: adapter as any })
    await toPromise(orch.chat('Turn one'))
    await toPromise(orch.chat('Turn two'))

    expect(adapter.calls).toHaveLength(2)
    const secondCallMsgs = adapter.calls[1]!.messages.filter(m => m.role !== 'system')
    // Should have: user(turn1), model(first response), user(turn2)
    expect(secondCallMsgs.length).toBeGreaterThanOrEqual(3)
    const userMsgs = secondCallMsgs.filter(m => m.role === 'user')
    expect(userMsgs.some(m => m.content === 'Turn one')).toBe(true)
    expect(userMsgs.some(m => m.content === 'Turn two')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Template path still works (supportsNativeTools absent/false)
// ---------------------------------------------------------------------------

describe('Orchestrator template path (no supportsNativeTools)', () => {
  class TemplateAdapter extends KoboldAdapter {
    readonly generateRawCalls: string[] = []

    constructor(private readonly turns: ParsedTurn[]) {
      super({ apiServer: 'http://localhost', template: Profiles.qwen })
    }

    private index = 0
    override async generateRaw(prompt: string): Promise<ParsedTurn> {
      this.generateRawCalls.push(prompt)
      const turn = this.turns[this.index] ?? this.turns[this.turns.length - 1]!
      this.index++
      return turn
    }
  }

  test('calls generateRaw when supportsNativeTools is absent', async () => {
    const adapter = new TemplateAdapter([makeTurn({ content: 'Template response.' })])
    const orch = new Orchestrator({ adapter })

    const result = await toPromise(orch.chat('Hello'))

    expect(turnContent(result.turn)).toBe('Template response.')
    expect(adapter.generateRawCalls).toHaveLength(1)
    expect(adapter.generateRawCalls[0]!.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Router: gemini-native and gemini-interactions provider resolution
// ---------------------------------------------------------------------------

describe('ModelRouter Gemini providers', () => {
  test('gemini-native resolves without throwing', () => {
    const router = ModelRouter.fromLegacyEnv({
      apiType: 'gemini-native',
      apiServer: 'https://generativelanguage.googleapis.com',
      apiKey: 'fake-key',
      model: 'gemini-3.1-flash-lite-preview',
    })
    const adapter = router.getAdapter('default')
    expect(adapter).toBeDefined()
    expect((adapter as any).supportsNativeTools).toBe(true)
  })

  test('gemini-interactions resolves without throwing', () => {
    const router = ModelRouter.fromLegacyEnv({
      apiType: 'gemini-interactions',
      apiServer: 'https://generativelanguage.googleapis.com',
      apiKey: 'fake-key',
      model: 'gemini-3-flash-preview',
    })
    const adapter = router.getAdapter('default')
    expect(adapter).toBeDefined()
    expect((adapter as any).supportsNativeTools).toBe(true)
  })

  test('gemini-interactions store=false does not set previousInteractionId', () => {
    const adapter = new GeminiInteractionsAdapter({
      apiKey: 'fake',
      model: 'gemini-3-flash-preview',
      template: Profiles.qwen,
      store: false,
    })
    expect((adapter as any).previousInteractionId).toBeUndefined()
    adapter.resetSession()
    expect((adapter as any).previousInteractionId).toBeUndefined()
  })

  test('gemini-interactions store=true (default) tracks previousInteractionId', () => {
    const adapter = new GeminiInteractionsAdapter({
      apiKey: 'fake',
      model: 'gemini-3-flash-preview',
      template: Profiles.qwen,
    })
    ;(adapter as any).previousInteractionId = 'fake-session-id'
    expect((adapter as any).previousInteractionId).toBe('fake-session-id')

    adapter.resetSession()
    expect((adapter as any).previousInteractionId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// messagesToSDKContents — unit tests for the bugs found in production
// ---------------------------------------------------------------------------

import { messagesToSDKContents } from '../gemini'
import type { Message } from '../template'

describe('messagesToSDKContents', () => {
  test('tool_result with calls[] emits functionResponse (not functionCall)', () => {
    // Regression: tool_result messages carry calls[] for name recovery.
    // A branch ordering bug caused them to hit the functionCall branch instead.
    const messages: Message[] = [
      {
        role: 'model',
        content: '',
        calls: [{ tool: 'validate_plan', plan: '{}' }],
      },
      {
        role: 'tool_result',
        content: '',
        calls: [{ tool: 'validate_plan', plan: '{}' }],
        results: [{ value: '{"valid":true}' }],
      },
    ]

    const contents = messagesToSDKContents(messages)
    const toolResultContent = contents.find(c =>
      c.parts?.some((p: any) => p.functionResponse),
    )

    expect(toolResultContent).toBeDefined()
    expect(toolResultContent!.role).toBe('user')

    const part = toolResultContent!.parts.find((p: any) => p.functionResponse) as any
    expect(part.functionResponse.name).toBe('validate_plan')
    expect(part.functionResponse.response.output).toBe('{"valid":true}')
  })

  test('model message with calls[] emits functionCall parts', () => {
    const messages: Message[] = [
      {
        role: 'model',
        content: '',
        calls: [{ tool: 'bash', command: 'ls' }],
      },
    ]

    const contents = messagesToSDKContents(messages)
    const modelContent = contents.find(c => c.role === 'model')
    expect(modelContent).toBeDefined()

    const part = modelContent!.parts.find((p: any) => p.functionCall) as any
    expect(part).toBeDefined()
    expect(part.functionCall.name).toBe('bash')
  })

  test('object tool result values are JSON-stringified', () => {
    // Regression: Gemini proto rejects nested arrays inside functionResponse.
    // Object values must be stringified.
    const messages: Message[] = [
      {
        role: 'model',
        content: '',
        calls: [{ tool: 'run_plan' }],
      },
      {
        role: 'tool_result',
        content: '',
        calls: [{ tool: 'run_plan' }],
        results: [{ value: { ok: true, written: ['a.ts', 'b.ts'], ansibleReport: null } }],
      },
    ]

    const contents = messagesToSDKContents(messages)
    const part = contents
      .flatMap(c => c.parts)
      .find((p: any) => p.functionResponse) as any

    expect(typeof part.functionResponse.response.output).toBe('string')
    const parsed = JSON.parse(part.functionResponse.response.output)
    expect(parsed.ok).toBe(true)
    expect(parsed.written).toEqual(['a.ts', 'b.ts'])
  })

  test('mid-conversation system message is appended to last user part', () => {
    // Gemini requires strict alternation — inline system turns are appended
    // to the last user/tool_result part as extra text.
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'model', content: 'Hi' },
      { role: 'system', content: 'Please respond to the user.' },
    ]

    const contents = messagesToSDKContents(messages)
    // The injected system message should be appended to the last user/model part
    // that is role=user (or last part of role=user).
    // In this case there's no tool_result, so it should append to the 'model' turn... 
    // Actually per our code: appends to last 'user' role in out[].
    // Here last role='user' is 'Hello', so it gets appended there.
    const userContent = contents.find(c => c.role === 'user')
    const hasNudge = userContent?.parts?.some((p: any) =>
      typeof p.text === 'string' && p.text.includes('Please respond to the user.'),
    )
    expect(hasNudge).toBe(true)
  })

  test('long string results are truncated at MAX_RESULT chars', () => {
    const longValue = 'x'.repeat(10000)
    const messages: Message[] = [
      { role: 'model', content: '', calls: [{ tool: 'tool_library' }] },
      {
        role: 'tool_result',
        content: '',
        calls: [{ tool: 'tool_library' }],
        results: [{ value: longValue }],
      },
    ]

    const contents = messagesToSDKContents(messages)
    const part = contents
      .flatMap(c => c.parts)
      .find((p: any) => p.functionResponse) as any

    expect(part.functionResponse.response.output.length).toBeLessThan(longValue.length)
    expect(part.functionResponse.response.output.endsWith('...(truncated)')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator empty response nudge
// ---------------------------------------------------------------------------

describe('Orchestrator empty response nudge', () => {
  test('injects system nudge and retries when model returns completely empty response', async () => {
    // Regression: Gemini sometimes returns empty parts (no text, no calls) after
    // tool results. The orchestrator should nudge and retry rather than committing
    // empty agent rounds.
    let callCount = 0
    const adapter = new MockNativeAdapter([
      // First call: make a tool call
      makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'agent' } }] }),
      // Second call (after tool result): return empty — triggers nudge
      { steps: [] } as any,
      // Third call (after nudge): return real content
      makeTurn({ content: 'Done, switched to agent mode.' }),
    ])

    // Patch generate to count calls
    const origGenerate = adapter.generate.bind(adapter)
    adapter.generate = async function(messages: Message[], tools?: ToolDefinition[]) {
      callCount++
      return origGenerate(messages, tools)
    }

    const orch = new Orchestrator({ adapter: adapter as any })
    const result = await toPromise(orch.chat('Switch modes'))

    // Should have recovered and returned the real content
    expect(turnContent(result.turn)).toBe('Done, switched to agent mode.')
    // Should have made 3 generate calls total
    expect(callCount).toBe(3)
  })
})
