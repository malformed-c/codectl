import { describe, expect, test } from 'bun:test'
import {
  chatRound, agentRound, toolRound, systemRound, errorRound, fromJSON,
} from '../round'
import {
  userSpan, modelSpan, reasoningSpan, toolResultSpan, extractedSpan,
} from '../span'
import { VersionedMemory } from '../renderer'
import {
  extractionPass, reasoningPass, truncationPass, joinPass, makeFormatPass,
} from '../pipeline'
import { Profiles } from '../template'
import type { RenderContext } from '../round'

const ctx0: RenderContext = { age: 0, memory: new Map(), budget: Infinity }
const ctx1: RenderContext = { age: 1, memory: new Map(), budget: Infinity }
const ctx2: RenderContext = { age: 2, memory: new Map(), budget: Infinity }

// --- Round serialization ---

describe('round serialize / fromJSON', () => {
  test('chatRound serializes and deserializes', () => {
    const r = chatRound([userSpan('hello')], 'world', 'thought')
    const s = r.serialize()
    expect(s.kind).toBe('chat')
    if (s.kind !== 'chat') return
    expect(s.model).toBe('world')
    expect(s.reasoning).toBe('thought')
    expect(s.user[0]!.text).toBe('hello')

    const s2 = fromJSON(s).serialize()
    expect(s2.kind).toBe('chat')
    if (s2.kind === 'chat') expect(s2.model).toBe('world')
  })

  test('toolRound serializes and deserializes', () => {
    const r = toolRound(
      [{ tool: 'bash', command: 'ls' }],
      [{ value: 'file.txt' }],
      'thought',
      'content',
    )
    const s = r.serialize()
    expect(s.kind).toBe('tool')
    if (s.kind !== 'tool') return
    expect(s.calls).toHaveLength(1)
    expect(s.results).toHaveLength(1)

    const s2 = fromJSON(s).serialize()
    if (s2.kind === 'tool') expect(s2.calls[0]!.tool).toBe('bash')
  })

  test('agentRound nests children correctly and round-trips', () => {
    const tool = toolRound([{ tool: 'bash', command: 'ls' }], [{ value: 'ok' }])
    const agent = agentRound([], [tool])
    const s = agent.serialize()
    expect(s.kind).toBe('agent')
    if (s.kind !== 'agent') return
    expect(s.rounds).toHaveLength(1)
    expect(s.rounds[0]!.kind).toBe('tool')
    expect(s.trigger).toHaveLength(0)

    const s2 = fromJSON(s).serialize()
    if (s2.kind === 'agent') expect(s2.rounds[0]!.kind).toBe('tool')
  })

  test('systemRound serializes and deserializes', () => {
    const r = systemRound('system intervention')
    const s = r.serialize()
    expect(s.kind).toBe('system')
    if (s.kind === 'system') expect(s.message).toBe('system intervention')

    const s2 = fromJSON(s).serialize()
    if (s2.kind === 'system') expect(s2.message).toBe('system intervention')
  })

  test('errorRound serializes message and input', () => {
    const r = errorRound('parse failed', 'bad json{')
    const s = r.serialize()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.message).toBe('parse failed')
      expect(s.input).toBe('bad json{')
    }
  })
})

// --- Round spans + age behavior ---

describe('round spans - age behavior', () => {
  test('chatRound age 0: includes reasoning spans', () => {
    const r = chatRound([userSpan('q')], 'answer', 'thought')
    const spans = r.spans(ctx0)
    expect(spans.some(s => s.kind === 'reasoning')).toBe(true)
  })

  test('chatRound always emits reasoning spans (reasoningPass drops them)', () => {
    // chatRound.spans() always includes reasoning - dropping happens at reasoningPass
    const r = chatRound([userSpan('q')], 'answer', 'thought')
    expect(r.spans(ctx0).some(s => s.kind === 'reasoning')).toBe(true)
    // age 1 still includes reasoning from round.spans() - pipeline drops it
    expect(r.spans(ctx1).some(s => s.kind === 'reasoning')).toBe(true)
  })

  test('systemRound age 2: returns empty', () => {
    const r = systemRound('message')
    expect(r.spans(ctx2)).toHaveLength(0)
  })

  test('errorRound age 2: returns empty', () => {
    const r = errorRound('error')
    expect(r.spans(ctx2)).toHaveLength(0)
  })

  test('agentRound age 0: includes all children tool calls', () => {
    const children = Array.from({ length: 4 }, (_, i) =>
      toolRound([{ tool: 'bash', command: `cmd${i}` }], [{ value: `r${i}` }])
    )
    const agent = agentRound([], children)
    const spans = agent.spans(ctx0)
    const toolCallSpans = spans.filter(s => s.kind === 'tool_call')
    expect(toolCallSpans).toHaveLength(4)
  })

  test('agentRound age 1: includes last 3 children', () => {
    const children = Array.from({ length: 5 }, (_, i) =>
      toolRound([{ tool: 'bash', command: `cmd${i}` }], [{ value: `r${i}` }])
    )
    const agent = agentRound([], children)
    const spans = agent.spans(ctx1)
    const toolCallSpans = spans.filter(s => s.kind === 'tool_call')
    expect(toolCallSpans).toHaveLength(3)
  })

  test('agentRound age 2: collapses children, only response survives', () => {
    const children = Array.from({ length: 4 }, (_, i) =>
      toolRound([{ tool: 'bash', command: `cmd${i}` }], [{ value: `r${i}` }])
    )
    const agent = agentRound([], children, 'final answer')
    const spans = agent.spans(ctx2)
    // No tool calls at age 2 - entire loop collapsed
    const toolCallSpans = spans.filter(s => s.kind === 'tool_call')
    expect(toolCallSpans).toHaveLength(0)
    // Response still present
    const modelSpans = spans.filter(s => s.kind === 'model')
    expect(modelSpans).toHaveLength(1)
    expect(modelSpans[0]!.text).toBe('final answer')
  })
})

// --- Pipeline passes ---

describe('reasoningPass', () => {
  test('age 0: keeps reasoning spans', () => {
    const spans = [reasoningSpan('plan'), modelSpan('response')]
    const out = reasoningPass(spans, ctx0)
    expect(out.some(s => s.kind === 'reasoning')).toBe(true)
  })

  test('age 1: drops reasoning spans, keeps model spans', () => {
    const spans = [reasoningSpan('plan'), modelSpan('response')]
    const out = reasoningPass(spans, ctx1)
    expect(out.some(s => s.kind === 'reasoning')).toBe(false)
    expect(out.some(s => s.kind === 'model')).toBe(true)
  })
})

describe('truncationPass', () => {
  test('age 0: tool_result spans pass through unchanged', () => {
    const spans = [toolResultSpan([{ value: 'hello' }], 'hello', true)]
    const out = truncationPass(spans, ctx0)
    expect(out[0]!.text).toBe('hello')
  })

  test('age 1: large truncatable tool results are shortened', () => {
    const bigValue = 'x'.repeat(2000)
    const spans = [toolResultSpan([{ value: bigValue }], bigValue, true)]
    const out = truncationPass(spans, ctx1)
    expect(out[0]!.text.length).toBeLessThan(bigValue.length)
  })

  test('non-tool_result spans pass through regardless of age', () => {
    const spans = [reasoningSpan('thought'), modelSpan('response')]
    const out = truncationPass(spans, ctx1)
    expect(out).toHaveLength(2)
  })
})

describe('extractionPass', () => {
  test('replaces span text with [Extracted to key] when memory key exists', () => {
    const mem = new Map([['mykey', 'big code block']])
    const ctx = { ...ctx0, memory: mem }
    const spans = [extractedSpan('big code block', 'mykey')]
    const out = extractionPass(spans, ctx)
    expect(out[0]!.text).toBe('[Extracted to mykey]')
  })

  test('leaves span unchanged when key is missing from memory', () => {
    const ctx = { ...ctx0, memory: new Map() }
    const spans = [extractedSpan('big code block', 'mykey')]
    const out = extractionPass(spans, ctx)
    expect(out[0]!.text).toBe('big code block')
  })

  test('passes through non-extracted spans unchanged', () => {
    const spans = [modelSpan('regular content')]
    const out = extractionPass(spans, ctx0)
    expect(out[0]!.text).toBe('regular content')
  })
})

// --- VersionedMemory ---

describe('VersionedMemory', () => {
  test('version increments on set', () => {
    const m = new VersionedMemory()
    const v0 = m.version
    m.set('k', 'v')
    expect(m.version).toBeGreaterThan(v0)
  })

  test('version increments on delete', () => {
    const m = new VersionedMemory()
    m.set('k', 'v')
    const v1 = m.version
    m.delete('k')
    expect(m.version).toBeGreaterThan(v1)
  })

  test('get/has/set work correctly', () => {
    const m = new VersionedMemory()
    expect(m.has('x')).toBe(false)
    m.set('x', 'val')
    expect(m.has('x')).toBe(true)
    expect(m.get('x')).toBe('val')
  })

  test('fromRecord initializes with provided values', () => {
    const m = VersionedMemory.fromRecord({ x: 'foo', y: 'bar' })
    expect(m.get('x')).toBe('foo')
    expect(m.get('y')).toBe('bar')
  })

  test('snapshot returns a full copy', () => {
    const m = VersionedMemory.fromRecord({ a: '1', b: '2' })
    const snap = m.snapshot()
    expect(snap.get('a')).toBe('1')
    expect(snap.get('b')).toBe('2')
    // Mutations to m don't affect snap
    m.set('a', 'changed')
    expect(snap.get('a')).toBe('1')
  })

  test('append concatenates to existing string value', () => {
    const m = new VersionedMemory()
    m.set('k', 'hello')
    m.append('k', ' world')
    expect(m.get('k')).toBe('hello world')
  })

  test('append sets value if key does not exist', () => {
    const m = new VersionedMemory()
    m.append('k', 'fresh')
    expect(m.get('k')).toBe('fresh')
  })

  test('clear resets all keys and increments version', () => {
    const m = VersionedMemory.fromRecord({ a: '1', b: '2' })
    const v = m.version
    m.clear()
    expect(m.get('a')).toBeUndefined()
    expect(Array.from(m.keys())).toHaveLength(0)
    expect(m.version).toBeGreaterThan(v)
  })

  test('keys() returns all stored keys', () => {
    const m = VersionedMemory.fromRecord({ a: '1', b: '2', c: '3' })
    const keys = Array.from(m.keys()).sort()
    expect(keys).toEqual(['a', 'b', 'c'])
  })
})
