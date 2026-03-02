import { describe, expect, test } from 'bun:test'
import { Fsm } from '../fsm'
import { userSpan } from '../span'
import { fromJSON } from '../round'

function u(text: string) { return [userSpan(text)] }

describe('FSM - chat flow', () => {
  test('idle -> awaiting_model -> idle (text-only response)', () => {
    const fsm = new Fsm()
    expect(fsm.history).toHaveLength(0)

    fsm.onUser(u('Hello'))
    fsm.onModel(undefined, 'Hi!', [])

    expect(fsm.history).toHaveLength(1)
    expect(fsm.history[0]!.serialize().kind).toBe('chat')
  })

  test('chat round captures user + model text + reasoning', () => {
    const fsm = new Fsm()
    fsm.onUser(u('user message'))
    fsm.onModel('thought', 'reply', [])

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'chat') throw new Error('not chat')
    expect(s.model).toBe('reply')
    expect(s.reasoning).toBe('thought')
    expect(s.user[0]!.text).toBe('user message')
  })

  test('multiple chat exchanges build up history', () => {
    const fsm = new Fsm()
    fsm.onUser(u('first'))
    fsm.onModel(undefined, 'reply1', [])
    fsm.onUser(u('second'))
    fsm.onModel(undefined, 'reply2', [])

    expect(fsm.history).toHaveLength(2)
    expect(fsm.history.every(r => r.serialize().kind === 'chat')).toBe(true)
  })

  test('cursor equals history length', () => {
    const fsm = new Fsm()
    expect(fsm.cursor).toBe(0)
    fsm.onUser(u('hello'))
    fsm.onModel(undefined, 'hi', [])
    expect(fsm.cursor).toBe(1)
  })
})

describe('FSM - agent flow', () => {
  test('tool call creates agent round with tool round inside', () => {
    const fsm = new Fsm()
    fsm.onUser(u('do stuff'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: { stdout: 'file.txt' } }])
    fsm.onModel(undefined, 'Done!', [])

    // history: ChatRound(user) + AgentRound + ChatRound(done)
    expect(fsm.history).toHaveLength(3)
    const agent = fsm.history[1]!.serialize()
    expect(agent.kind).toBe('agent')
    if (agent.kind === 'agent') {
      expect(agent.rounds).toHaveLength(1)
      expect(agent.rounds[0]!.kind).toBe('tool')
    }
  })

  test('agent round commits user turn as separate chat round first', () => {
    const fsm = new Fsm()
    fsm.onUser(u('user message'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])

    // user chat round committed immediately when agent opens
    const s = fsm.history[0]!.serialize()
    expect(s.kind).toBe('chat')
    if (s.kind === 'chat') expect(s.model).toBe('')
  })

  test('multiple tool rounds accumulate in same agent', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'a' }])
    fsm.onResults([{ value: 'result_a' }])
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'b' }])
    fsm.onResults([{ value: 'result_b' }])
    fsm.onModel(undefined, 'Complete', [])

    const agent = fsm.history[1]!.serialize()
    if (agent.kind !== 'agent') throw new Error('not agent')
    expect(agent.rounds).toHaveLength(2)
    expect(agent.rounds.every(r => r.kind === 'tool')).toBe(true)
  })

  test('onDone closes agent and emits chat round with result', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onDone('task complete')

    expect(fsm.history).toHaveLength(3) // chat(user), agent, chat(done)
    const last = fsm.history[2]!.serialize()
    if (last.kind !== 'chat') throw new Error('not chat')
    expect(last.model).toBe('task complete')
  })
})

describe('FSM - error handling', () => {
  test('onError inside agent adds ErrorRound to children', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onError('Something went wrong', 'bad input')
    fsm.onModel(undefined, 'Done', [])

    const agent = fsm.history[1]!.serialize()
    if (agent.kind !== 'agent') throw new Error('not agent')
    const err = agent.rounds.find(r => r.kind === 'error')
    expect(err).toBeTruthy()
    if (err?.kind === 'error') {
      expect(err.message).toBe('Something went wrong')
      expect(err.input).toBe('bad input')
    }
  })

  test('model turn before results produces FSM violation ErrorRound', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    // FSM violation: second onModel before results
    fsm.onModel(undefined, 'unexpected', [])
    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Done', [])

    const agent = fsm.history[1]!.serialize()
    if (agent.kind !== 'agent') throw new Error('not agent')
    expect(agent.rounds.some(r => r.kind === 'error')).toBe(true)
  })

  test('onSystem inside agent adds SystemRound to children', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onSystem('Mode switched')
    fsm.onModel(undefined, 'Done', [])

    const agent = fsm.history[1]!.serialize()
    if (agent.kind !== 'agent') throw new Error('not agent')
    expect(agent.rounds.some(r => r.kind === 'system')).toBe(true)
  })

  test('onError outside agent commits ErrorRound to main history', () => {
    const fsm = new Fsm()
    fsm.onUser(u('hello'))
    fsm.onModel(undefined, 'reply', [])
    fsm.onError('post-chat error')

    expect(fsm.history).toHaveLength(2)
    expect(fsm.history[1]!.serialize().kind).toBe('error')
  })
})

describe('FSM - abort / force-close', () => {
  test('onAbort in awaiting_model commits empty chat round', () => {
    const fsm = new Fsm()
    fsm.onUser(u('message'))
    fsm.onAbort()

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    expect(s.kind).toBe('chat')
    if (s.kind === 'chat') expect(s.model).toBe('')
  })

  test('onAbort in awaiting_results leaves abort error in agent', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    // results never arrive
    fsm.onAbort()

    const agent = fsm.history.find(r => r.serialize().kind === 'agent')
    expect(agent).toBeTruthy()
    const s = agent!.serialize()
    if (s.kind === 'agent') {
      expect(s.rounds.some(r => r.kind === 'error')).toBe(true)
    }
  })

  test('onAbort in in_agent commits accumulated tool rounds', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    // in_agent now - abort without final model response
    fsm.onAbort()

    const agent = fsm.history.find(r => r.serialize().kind === 'agent')
    expect(agent).toBeTruthy()
    const s = agent!.serialize()
    if (s.kind === 'agent') {
      expect(s.rounds).toHaveLength(1)
      expect(s.rounds[0]!.kind).toBe('tool')
    }
  })

  test('onAbort in idle is a no-op', () => {
    const fsm = new Fsm()
    fsm.onAbort() // should not throw
    expect(fsm.history).toHaveLength(0)
  })
})

describe('FSM - headless run (no user turn)', () => {
  test('text-only response from idle creates bare chat round with empty user', () => {
    const fsm = new Fsm()
    fsm.onModel(undefined, 'Hello!', [])

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    expect(s.kind).toBe('chat')
    if (s.kind === 'chat') {
      expect(s.model).toBe('Hello!')
      expect(s.user).toHaveLength(0)
    }
  })

  test('tool call from idle opens agent with empty userSpans', () => {
    const fsm = new Fsm()
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Done', [])

    expect(fsm.history.some(r => r.serialize().kind === 'agent')).toBe(true)
  })
})

describe('FSM - getRenderableHistory', () => {
  test('includes pending user turn in awaiting_model state (not committed yet)', () => {
    const fsm = new Fsm()
    fsm.onUser(u('pending'))

    const h = fsm.getRenderableHistory()
    expect(h).toHaveLength(1)
    expect(h[0]!.serialize().kind).toBe('chat')
    // Not committed to history yet
    expect(fsm.history).toHaveLength(0)
  })

  test('includes pending agent round in awaiting_results state', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])

    const h = fsm.getRenderableHistory()
    const agentRendered = h.find(r => r.serialize().kind === 'agent')
    expect(agentRendered).toBeTruthy()
    // Only the user chat round committed to actual history
    expect(fsm.history).toHaveLength(1)
  })

  test('committed history only - idle state', () => {
    const fsm = new Fsm()
    fsm.onUser(u('hello'))
    fsm.onModel(undefined, 'hi', [])

    const h = fsm.getRenderableHistory()
    expect(h).toHaveLength(fsm.history.length)
  })
})

describe('FSM - hydrate (checkpoint restore)', () => {
  test('hydrate restores history to idle state', () => {
    const original = new Fsm()
    original.onUser(u('hello'))
    original.onModel(undefined, 'hi', [])

    const serialized = original.history.map(r => r.serialize())

    const restored = new Fsm()
    restored.hydrate(serialized.map(fromJSON))

    expect(restored.history).toHaveLength(1)
    expect(restored.cursor).toBe(1)
    expect(restored.history[0]!.serialize().kind).toBe('chat')
  })

  test('hydrate preserves tool round data', () => {
    const original = new Fsm()
    original.onUser(u('task'))
    original.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    original.onResults([{ value: { stdout: 'file.txt' } }])
    original.onModel(undefined, 'done', [])

    const serialized = original.history.map(r => r.serialize())
    const restored = new Fsm()
    restored.hydrate(serialized.map(fromJSON))

    expect(restored.history).toHaveLength(3)
    const agent = restored.history.find(r => r.serialize().kind === 'agent')
    expect(agent).toBeTruthy()
  })
})

describe('FSM - consecutive user messages', () => {
  test('second onUser in awaiting_model appends to existing userSpans', () => {
    const fsm = new Fsm()
    fsm.onUser(u('first'))
    fsm.onUser(u('second')) // model hasn't responded yet
    fsm.onModel(undefined, 'reply', [])

    // Should still produce 1 chat round
    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind === 'chat') {
      const userText = s.user.map(sp => sp.text).join('')
      expect(userText).toContain('first')
      expect(userText).toContain('second')
    }
  })
})
