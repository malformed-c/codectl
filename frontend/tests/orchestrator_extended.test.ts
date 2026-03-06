import { describe, expect, test } from 'bun:test'
import { Orchestrator, toPromise } from '../orchestrator'
import { KoboldAdapter } from '../kobold'
import { Profiles, makeTurn, turnContent } from '../template'
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

async function runAndCollectResults(orch: Orchestrator, message: string) {
  const results: Array<{ name: string; result: unknown; error?: string }> = []
  for await (const event of orch.chat(message)) {
    if (event.kind === 'call_result') {
      results.push({ name: event.call.name, result: event.result.result, error: event.result.error })
    }
  }
  return results
}

describe('tool_library', () => {
  test('returns tool definitions without prefix filter', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'tool_library', arguments: {} }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    const results = await runAndCollectResults(orch, 'list tools')
    const libResult = results.find(r => r.name === 'tool_library')
    expect(libResult).toBeTruthy()
    expect(typeof libResult!.result).toBe('string')
    expect(libResult!.result as string).toContain('memory')
  })

  test('filters tools by prefix', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'tool_library', arguments: { prefix: 'memory' } }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    const results = await runAndCollectResults(orch, 'list memory tools')
    const output = results.find(r => r.name === 'tool_library')!.result as string
    expect(output).toContain('memory')
    expect(output).not.toContain('bash')
    expect(output).not.toContain('"mode"')
  })

  test('wraps output in [AVAILABLE_TOOLS] for mistral template', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'tool_library', arguments: {} }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    const results = await runAndCollectResults(orch, 'list tools')
    const output = results.find(r => r.name === 'tool_library')!.result as string
    expect(output).toContain('[AVAILABLE_TOOLS]')
    expect(output).toContain('[/AVAILABLE_TOOLS]')
  })
})

describe('memory tool integration', () => {
  test('set and get values persist within session', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'memory', arguments: { action: 'set', key: 'x', content: 'hello' } }] }),
        makeTurn({ toolCalls: [{ name: 'memory', arguments: { action: 'get', key: 'x' } }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    const results = await runAndCollectResults(orch, 'test memory')
    const getResult = results.find((r, i) => r.name === 'memory' && i > 0)
    expect(getResult).toBeTruthy()
    expect((getResult!.result as any)?.content).toBe('hello')
  })
})

describe('mode switching', () => {
  test('mode tool switches to agent', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'agent' } }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    await toPromise(orch.chat('switch to agent'))
    expect(orch.getMode().kind).toBe('agent')
  })

  test('mode switches back to chat', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'agent' } }] }),
        makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'chat' } }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    await toPromise(orch.chat('switch modes'))
    expect(orch.getMode().kind).toBe('chat')
  })
})

describe('malformed tool call handling', () => {
  test('malformed flag is preserved on parsed turn', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([makeTurn({ content: 'done', malformed: true })]),
    })
    const result = await toPromise(orch.chat('test'))
    expect(turnContent(result.turn)).toBe('done')
  })

  test('3 consecutive tool failures eject agent to chat mode', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'mode', arguments: { mode: 'agent' } }] }),
        makeTurn({ toolCalls: [{ name: 'nonexistent_tool', arguments: {} }] }),
        makeTurn({ toolCalls: [{ name: 'nonexistent_tool', arguments: {} }] }),
        makeTurn({ toolCalls: [{ name: 'nonexistent_tool', arguments: {} }] }),
        makeTurn({ content: 'done' }),
      ]),
    })
    await toPromise(orch.chat('test ejection'))
    expect(orch.getMode().kind).toBe('chat')
  })
})

describe('done tool', () => {
  test('done tool closes agent loop with result', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        makeTurn({ toolCalls: [{ name: 'done', arguments: { result: 'task finished' } }] }),
      ]),
    })
    const result = await toPromise(orch.chat('do task'))
    expect(turnContent(result.turn)).toBe('task finished')
  })
})
