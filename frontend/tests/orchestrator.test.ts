import { expect, test, describe } from 'bun:test'
import { Orchestrator } from '../orchestrator'
import { Profiles } from '../template'
import { KoboldAdapter } from '../kobold'

// Mock adapter
class MockAdapter extends KoboldAdapter {
  constructor() {
    super({ apiServer: 'http://localhost', template: Profiles.mistral })
  }
  override async generate(messages: any) {
    // console.log('DEBUG messages:', JSON.stringify(messages, null, 2));
    const lastMessage = messages[messages.length - 1]
    if (lastMessage.content.includes('Hello')) {
      return { content: 'Hi there!', think: 'User said hello.' }
    }
    if (lastMessage.role === 'tool_result') {
      return { content: 'Tool executed successfully.' }
    }
    if (lastMessage.content.includes('call tool')) {
      return {
        content: 'Calling tool...',
        toolCalls: ['mode[ARGS]{"mode": "code/plan"}']
      }
    }
    return { content: "I don't understand." }
  }
}

describe('Orchestrator', () => {
  test('chat handles simple interaction', async () => {
    const orch = new Orchestrator({ adapter: new MockAdapter() })
    const result = await orch.chat('Hello')

    expect(result.turn.content).toBe('Hi there!')
    expect(result.turn.think).toBe('User said hello.')
    expect(orch.getHistory()).toHaveLength(3) // system, user, assistant
  })

  test('chat handles tool calls', async () => {
    const orch = new Orchestrator({ adapter: new MockAdapter() })
    const result = await orch.chat('Please call tool')

    expect(result.turn.content).toBe('Tool executed successfully.')
    expect(result.toolsExecuted).toHaveLength(1)
    expect(result.toolsExecuted[0]!.call.name).toBe('mode')
    expect(orch.getMode().kind).toBe('code/plan')
  })
})
