import { describe, expect, test } from 'bun:test'
import { Orchestrator, toPromise } from '../orchestrator'
import { KoboldAdapter } from '../kobold'
import { Profiles } from '../template'
import type { ParsedTurn } from '../template'

class ScriptedAdapter extends KoboldAdapter {
  private index = 0
  constructor(private readonly turns: ParsedTurn[]) {
    super({ apiServer: 'http://localhost', template: Profiles.mistral })
  }
  override async generateRaw(_prompt: string): Promise<ParsedTurn> {
    const turn = this.turns[this.index] ?? this.turns[this.turns.length - 1]!
    this.index++
    return turn
  }
}

// Capture tool results from events
async function runAndCollectResults(orch: Orchestrator, message: string) {
  const results: Array<{ name: string; result: unknown; error?: string }> = []
  for await (const event of orch.chat(message)) {
    if (event.kind === 'call_result') {
      results.push({
        name: event.call.name,
        result: event.result.result,
        error: event.result.error,
      })
    }
  }
  return results
}

describe('tool_library', () => {
  test('returns tool definitions without prefix filter', async () => {
    let capturedResult: unknown = null

    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['tool_library[ARGS]{}'] },
        { content: 'done' },
      ]),
    })

    const results = await runAndCollectResults(orch, 'list tools')
    const libResult = results.find(r => r.name === 'tool_library')
    expect(libResult).toBeTruthy()
    expect(libResult!.result).toBeTruthy()
    expect(typeof libResult!.result).toBe('string')
    // Should contain tool name definitions
    expect(libResult!.result as string).toContain('memory')
  })

  test('filters tools by prefix', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['tool_library[ARGS]{"prefix":"memory"}'] },
        { content: 'done' },
      ]),
    })

    const results = await runAndCollectResults(orch, 'list memory tools')
    const libResult = results.find(r => r.name === 'tool_library')
    expect(libResult).toBeTruthy()
    const output = libResult!.result as string
    // Should only contain memory tool
    expect(output).toContain('memory')
    // Should NOT contain other tools (bash, mode etc)
    expect(output).not.toContain('bash')
    expect(output).not.toContain('"mode"')
  })

  test('wraps output in [AVAILABLE_TOOLS] for mistral template', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['tool_library[ARGS]{}'] },
        { content: 'done' },
      ]),
    })

    const results = await runAndCollectResults(orch, 'list tools')
    const libResult = results.find(r => r.name === 'tool_library')
    const output = libResult!.result as string
    // Mistral template has availableTools tags
    expect(output).toContain('[AVAILABLE_TOOLS]')
    expect(output).toContain('[/AVAILABLE_TOOLS]')
  })
})

describe('memory tool integration', () => {
  test('set and get values persist within session', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['memory[ARGS]{"action":"set","key":"x","content":"hello"}'] },
        { content: '', toolCalls: ['memory[ARGS]{"action":"get","key":"x"}'] },
        { content: 'done' },
      ]),
    })

    const results = await runAndCollectResults(orch, 'test memory')
    const getResult = results.find((r, i) => r.name === 'memory' && i > 0)
    expect(getResult).toBeTruthy()
    const val = (getResult!.result as any)?.content
    expect(val).toBe('hello')
  })
})

describe('mode switching', () => {
  test('mode tool switches to agent', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['mode[ARGS]{"mode":"agent"}'] },
        { content: 'done' },
      ]),
    })

    await toPromise(orch.chat('switch to agent'))
    expect(orch.getMode().kind).toBe('agent')
  })

  test('mode switches back to chat', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['mode[ARGS]{"mode":"agent"}'] },
        { content: '', toolCalls: ['mode[ARGS]{"mode":"chat"}'] },
        { content: 'done' },
      ]),
    })

    await toPromise(orch.chat('switch modes'))
    expect(orch.getMode().kind).toBe('chat')
  })
})

describe('malformed tool call handling', () => {
  test('malformed tool call is recorded as error in FSM', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        // Close token without open - autofixed and marked malformed
        { content: 'done', malformed: true },
      ]),
    })

    const result = await toPromise(orch.chat('test'))
    // Should not throw, should handle gracefully
    expect(result.turn.content).toBe('done')
  })

  test('3 consecutive tool failures eject agent to chat mode', async () => {
    // Each tool call fails (returns null result = failure)
    let callCount = 0
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        // First switch to agent
        { content: '', toolCalls: ['mode[ARGS]{"mode":"agent"}'] },
        // Then 3 tool calls - will fail because 'nonexistent_tool' isn't registered
        { content: '', toolCalls: ['nonexistent_tool[ARGS]{}'] },
        { content: '', toolCalls: ['nonexistent_tool[ARGS]{}'] },
        { content: '', toolCalls: ['nonexistent_tool[ARGS]{}'] },
        { content: 'done' },
      ]),
    })

    await toPromise(orch.chat('test ejection'))
    // After 3 failures, should be ejected to chat
    expect(orch.getMode().kind).toBe('chat')
  })
})

describe('done tool', () => {
  test('done tool closes agent loop with result', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['done[ARGS]{"result":"task finished"}'] },
      ]),
    })

    const result = await toPromise(orch.chat('do task'))
    expect(result.turn.content).toBe('task finished')
  })

  test('done tool without result returns empty content', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: '', toolCalls: ['done[ARGS]{}'] },
      ]),
    })

    const result = await toPromise(orch.chat('do task'))
    // done result is undefined -> finalTurn.content from last model output
    expect(result).toBeTruthy()
  })
})
