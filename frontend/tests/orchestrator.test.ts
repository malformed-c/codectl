import { expect, test, describe } from 'bun:test'
import { Orchestrator, toPromise } from '../orchestrator'
import { Profiles } from '../template'
import { KoboldAdapter } from '../kobold'
import type { ParsedTurn } from '../template'

class ScriptedAdapter extends KoboldAdapter {
  private index = 0

  constructor(private readonly turns: ParsedTurn[]) {
    super({ apiServer: 'http://localhost', template: Profiles.mistral })
  }

  override async generateRaw(_prompt: string): Promise<ParsedTurn> {
    const turn = this.turns[this.index] ?? this.turns[this.turns.length - 1]!
    this.index += 1

    return turn
  }
}

describe('Orchestrator', () => {
  test('chat handles simple interaction', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        { content: 'Hi there!', think: 'User said hello.' },
      ])
    })

    const result = await toPromise(orch.chat('Hello'))

    expect(result.turn.content).toBe('Hi there!')
    expect(result.turn.think).toBe('User said hello.')
    expect(orch.getHistory()).toHaveLength(1)
  })

  test('chat handles tool calls', async () => {
    const orch = new Orchestrator({
      adapter: new ScriptedAdapter([
        {
          content: 'Calling tool...',
          toolCalls: ['mode[ARGS]{"mode": "agent"}']
        },
        { content: 'Tool executed successfully.' },
      ])
    })

    const result = await toPromise(orch.chat('Please call tool'))

    expect(result.turn.content).toBe('Tool executed successfully.')
    expect(result.toolsExecuted).toHaveLength(1)
    expect(result.toolsExecuted[0]!.call.name).toBe('mode')
    expect(orch.getMode().kind).toBe('agent')
  })
})
