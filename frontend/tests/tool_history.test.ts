import { describe, expect, test } from 'bun:test'
import { KoboldAdapter } from '../kobold'
import { Orchestrator } from '../orchestrator'
import { Profiles } from '../template'

class HistoryAdapter extends KoboldAdapter {
  constructor() {
    super({ apiServer: 'http://localhost', template: Profiles.mistral })
  }

  override async generate(messages: any) {
    const last = messages[messages.length - 1]

    if (last.role === 'tool_result') {
      return { content: 'done' }
    }

    return {
      toolCalls: ['bash[ARGS]{}\nw[ARGS]{}\nid[ARGS]{}'],
    }
  }
}

describe('tool_call history', () => {
  test('stores parsed tool calls as structured json', async () => {
    const orch = new Orchestrator({ adapter: new HistoryAdapter() })
    await orch.chat('run commands')

    const toolCall = orch.getHistory().find((m) => m.role === 'tool_call')
    expect(toolCall).toBeTruthy()

    const parsed = JSON.parse(toolCall!.content) as { raw: string; calls: Array<{ name: string; arguments: Record<string, unknown> }> }
    expect(parsed.raw).toBe('bash[ARGS]{}\nw[ARGS]{}\nid[ARGS]{}')
    expect(parsed.calls).toEqual([
      { name: 'bash', arguments: { command: 'w' } },
      { name: 'bash', arguments: { command: 'id' } },
    ])
  })
})
