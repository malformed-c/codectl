import { describe, expect, test } from 'bun:test'
import { roundsToMessages } from '../native_messages'
import { chatRound, agentRound, toolRound, systemRound } from '../round'
import { userSpan, modelSpan, systemSpan } from '../span'

describe('roundsToMessages', () => {
  test('injects system prompt as first message', () => {
    const messages = roundsToMessages([], 'You are a helpful assistant.')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'system', content: 'You are a helpful assistant.' })
  })

  test('converts chatRound to user + assistant messages', () => {
    const round = chatRound([userSpan('Hello')], 'Hi there!')
    const messages = roundsToMessages([round], '')

    const nonSystem = messages.filter(m => m.role !== 'system')
    expect(nonSystem).toHaveLength(2)
    expect(nonSystem[0]).toMatchObject({ role: 'user', content: 'Hello' })
    expect(nonSystem[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' })
  })

  test('chatRound with no model text omits assistant message', () => {
    const round = chatRound([userSpan('Hello')], '')
    const messages = roundsToMessages([round], '')
    const nonSystem = messages.filter(m => m.role !== 'system')
    expect(nonSystem).toHaveLength(1)
    expect(nonSystem[0]!.role).toBe('user')
  })

  test('systemRound becomes system message', () => {
    const round = systemRound('Mode switched to agent.')
    const messages = roundsToMessages([round], '')
    expect(messages.some(m => m.role === 'system' && m.content === 'Mode switched to agent.')).toBe(true)
  })

  test('toolRound emits assistant call message + tool_result message', () => {
    const calls = [{ tool: 'bash', command: 'ls' }]
    const results = [{ value: 'file.ts\n' }]
    const round = toolRound(calls, results)
    const messages = roundsToMessages([round], '')

    const nonSystem = messages.filter(m => m.role !== 'system')
    expect(nonSystem).toHaveLength(2)

    const callMsg = nonSystem[0]!
    expect(callMsg.role).toBe('assistant')
    expect(callMsg.calls).toHaveLength(1)
    expect(callMsg.calls![0]!.tool).toBe('bash')

    const resultMsg = nonSystem[1]!
    expect(resultMsg.role).toBe('tool_result')
    expect(resultMsg.results).toHaveLength(1)
    expect(resultMsg.results![0]!.value).toBe('file.ts\n')
    // calls are echoed alongside results for tool name recovery
    expect(resultMsg.calls).toHaveLength(1)
    expect(resultMsg.calls![0]!.tool).toBe('bash')
  })

  test('agentRound emits trigger + children + response', () => {
    const toolCall = [{ tool: 'bash', command: 'echo hi' }]
    const toolResult = [{ value: 'hi\n' }]
    const child = toolRound(toolCall, toolResult)

    const round = agentRound([userSpan('Do the thing')], [child], 'Done.')
    const messages = roundsToMessages([round], '')

    const nonSystem = messages.filter(m => m.role !== 'system')
    // user trigger, assistant call, tool_result, assistant response
    expect(nonSystem[0]).toMatchObject({ role: 'user', content: 'Do the thing' })
    expect(nonSystem[nonSystem.length - 1]).toMatchObject({ role: 'assistant', content: 'Done.' })
    const resultMsg = nonSystem.find(m => m.role === 'tool_result')
    expect(resultMsg).toBeTruthy()
  })

  test('multiple rounds are appended in order', () => {
    const r1 = chatRound([userSpan('First')], 'Response 1')
    const r2 = chatRound([userSpan('Second')], 'Response 2')
    const messages = roundsToMessages([r1, r2], 'sys')

    const nonSystem = messages.filter(m => m.role !== 'system')
    expect(nonSystem).toHaveLength(4)
    expect(nonSystem[0]!.content).toBe('First')
    expect(nonSystem[1]!.content).toBe('Response 1')
    expect(nonSystem[2]!.content).toBe('Second')
    expect(nonSystem[3]!.content).toBe('Response 2')
  })

  test('tool result carries parallel call array for name recovery', () => {
    const calls = [{ tool: 'memory_graph', action: 'search', query: 'foo' }, { tool: 'bash', command: 'pwd' }]
    const results = [{ value: '[]' }, { value: '/home\n' }]
    const round = toolRound(calls, results)
    const messages = roundsToMessages([round], '')

    const resultMsg = messages.find(m => m.role === 'tool_result')!
    expect(resultMsg.calls![0]!.tool).toBe('memory_graph')
    expect(resultMsg.calls![1]!.tool).toBe('bash')
    expect(resultMsg.results![0]!.value).toBe('[]')
    expect(resultMsg.results![1]!.value).toBe('/home\n')
  })
})
