import { describe, expect, test } from 'bun:test'
import { Fsm } from '../fsm'
import { userSpan } from '../span'
import { fromJSON } from '../round'

function u(text: string) { return [userSpan(text)] }

describe('FSM - chat flow', () => {
  test('idle -> chat -> idle (text-only response)', () => {
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
  test('tool call produces single AgentRound (no separate user ChatRound)', () => {
    const fsm = new Fsm()
    fsm.onUser(u('do stuff'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: { stdout: 'file.txt' } }])
    fsm.onModel(undefined, 'Done!', [])

    // Single AgentRound - trigger + children + response all inside
    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    expect(s.kind).toBe('agent')
  })

  test('AgentRound owns the triggering user message', () => {
    const fsm = new Fsm()
    fsm.onUser(u('do stuff'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Done!', [])

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.trigger[0]!.text).toBe('do stuff')
    expect(s.response).toBe('Done!')
  })

  test('AgentRound contains tool rounds as children', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'file.txt' }])
    fsm.onModel(undefined, 'Done!', [])

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds).toHaveLength(1)
    expect(s.rounds[0]!.kind).toBe('tool')
  })

  test('multiple tool rounds accumulate as children in same AgentRound', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'a' }])
    fsm.onResults([{ value: 'result_a' }])
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'b' }])
    fsm.onResults([{ value: 'result_b' }])
    fsm.onModel(undefined, 'Complete', [])

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds).toHaveLength(2)
    expect(s.rounds.every(r => r.kind === 'tool')).toBe(true)
  })

  test('onDone closes agent with result in response field', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onDone('task complete')

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.response).toBe('task complete')
  })

  test('user message is never orphaned - no empty ChatRound emitted on tool call', () => {
    const fsm = new Fsm()
    fsm.onUser(u('important question'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])

    // No rounds committed yet - user message is in-flight with the agent state
    expect(fsm.history).toHaveLength(0)

    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Answer', [])

    // One AgentRound, trigger has the user message
    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.trigger[0]!.text).toBe('important question')
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

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    const err = s.rounds.find(r => r.kind === 'error')
    expect(err).toBeTruthy()
    if (err?.kind === 'error') {
      expect(err.message).toBe('Something went wrong')
      expect(err.input).toBe('bad input')
    }
  })

  test('onModel while results pending produces FSM violation ErrorRound', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    // FSM violation: second onModel before results arrive
    fsm.onModel(undefined, 'unexpected', [])
    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Done', [])

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds.some(r => r.kind === 'error')).toBe(true)
  })

  test('onSystem inside agent adds SystemRound to children', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onSystem('Mode switched')
    fsm.onModel(undefined, 'Done', [])

    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds.some(r => r.kind === 'system')).toBe(true)
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
  test('onAbort in chat state commits empty chat round', () => {
    const fsm = new Fsm()
    fsm.onUser(u('message'))
    fsm.onAbort()

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    expect(s.kind).toBe('chat')
    if (s.kind === 'chat') expect(s.model).toBe('')
  })

  test('onAbort with pending calls leaves abort error in agent children', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    // results never arrive
    fsm.onAbort()

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds.some(r => r.kind === 'error')).toBe(true)
    // trigger is preserved even on abort
    expect(s.trigger[0]!.text).toBe('task')
  })

  test('onAbort in agent (no pending) commits accumulated tool rounds', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    // in agent with no pending - abort without final model response
    fsm.onAbort()

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.rounds).toHaveLength(1)
    expect(s.rounds[0]!.kind).toBe('tool')
    expect(s.trigger[0]!.text).toBe('task')
  })

  test('onAbort in idle is a no-op', () => {
    const fsm = new Fsm()
    fsm.onAbort()
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

  test('tool call from idle opens agent with empty trigger', () => {
    const fsm = new Fsm()
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    fsm.onResults([{ value: 'ok' }])
    fsm.onModel(undefined, 'Done', [])

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.trigger).toHaveLength(0)
  })
})

describe('FSM - getRenderableHistory', () => {
  test('includes pending user turn in chat state (not committed yet)', () => {
    const fsm = new Fsm()
    fsm.onUser(u('pending'))

    const h = fsm.getRenderableHistory()
    expect(h).toHaveLength(1)
    expect(h[0]!.serialize().kind).toBe('chat')
    // Not committed to history yet
    expect(fsm.history).toHaveLength(0)
  })

  test('includes pending agent round in agent state (tool results not yet arrived)', () => {
    const fsm = new Fsm()
    fsm.onUser(u('task'))
    fsm.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])

    const h = fsm.getRenderableHistory()
    const agentRendered = h.find(r => r.serialize().kind === 'agent')
    expect(agentRendered).toBeTruthy()
    // Nothing committed yet
    expect(fsm.history).toHaveLength(0)
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

  test('hydrate preserves agent round data including trigger', () => {
    const original = new Fsm()
    original.onUser(u('task'))
    original.onModel(undefined, undefined, [{ tool: 'bash', command: 'ls' }])
    original.onResults([{ value: { stdout: 'file.txt' } }])
    original.onModel(undefined, 'done', [])

    const serialized = original.history.map(r => r.serialize())
    const restored = new Fsm()
    restored.hydrate(serialized.map(fromJSON))

    expect(restored.history).toHaveLength(1)
    const s = restored.history[0]!.serialize()
    if (s.kind !== 'agent') throw new Error('not agent')
    expect(s.trigger[0]!.text).toBe('task')
    expect(s.response).toBe('done')
    expect(s.rounds).toHaveLength(1)
  })
})

describe('FSM - consecutive user messages', () => {
  test('second onUser in chat state appends to existing userSpans', () => {
    const fsm = new Fsm()
    fsm.onUser(u('first'))
    fsm.onUser(u('second')) // model hasn't responded yet
    fsm.onModel(undefined, 'reply', [])

    expect(fsm.history).toHaveLength(1)
    const s = fsm.history[0]!.serialize()
    if (s.kind === 'chat') {
      const userText = s.user.map(sp => sp.text).join('')
      expect(userText).toContain('first')
      expect(userText).toContain('second')
    }
  })
})
