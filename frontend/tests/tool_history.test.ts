import { describe, expect, test } from 'bun:test'
import { KoboldAdapter } from '../kobold'
import { Orchestrator, toPromise } from '../orchestrator'
import { Profiles, makeTurn } from '../template'
import type { ParsedTurn } from '../template'

class HistoryAdapter extends KoboldAdapter {
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

describe('tool_call history (Round-based)', () => {
  test('stores parsed tool calls in ToolRound after agent run', async () => {
    const orch = new Orchestrator({
      adapter: new HistoryAdapter([
        // Turn 1: model emits 3 tool calls
        makeTurn({ toolCalls: [{ name: 'bash', arguments: {} }, { name: 'w', arguments: {} }, { name: 'id', arguments: {} }] }),

        // Turn 2: text-only response closes the agent run
        makeTurn({ content: 'done' }),
      ]),
    })

    await toPromise(orch.chat('run commands'))

    const history = orch.getHistory()

    // History should be: AgentRound (containing ToolRound) + ChatRound
    expect(history.length).toBeGreaterThanOrEqual(1)

    // Serialize to inspect internal structure
    const serialized = history.map(r => r.serialize())

    // Find the tool round inside the agent round
    const agentRound = serialized.find(r => r.kind === 'agent')
    expect(agentRound).toBeTruthy()

    if (agentRound?.kind === 'agent') {
      const toolRound = agentRound.rounds.find(r => r.kind === 'tool')
      expect(toolRound).toBeTruthy()

      if (toolRound?.kind === 'tool') {
        expect(toolRound.calls).toHaveLength(3)
        expect(toolRound.calls[0]).toMatchObject({ tool: 'bash' })
        expect(toolRound.calls[1]).toMatchObject({ tool: 'w' })
        expect(toolRound.calls[2]).toMatchObject({ tool: 'id' })
      }
    }
  })

  test('chat round captures user and model text', async () => {
    const orch = new Orchestrator({
      adapter: new HistoryAdapter([
        makeTurn({ content: 'Hello back!' }),
      ]),
    })

    await toPromise(orch.chat('Hello'))

    const serialized = orch.getHistory().map(r => r.serialize())
    const chatRound = serialized.find(r => r.kind === 'chat')

    expect(chatRound).toBeTruthy()

    if (chatRound?.kind === 'chat') {
      expect(chatRound.model).toBe('Hello back!')
    }
  })
})
