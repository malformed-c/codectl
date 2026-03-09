import { describe, expect, test } from 'bun:test'
import { AgentEntropyTracker } from '../agent-entropy'

describe('AgentEntropyTracker', () => {
  test('starts at zero score', () => {
    const t = new AgentEntropyTracker()
    expect(t.currentScore).toBe(0)
  })

  test('failure raises score by 2.0', () => {
    const t = new AgentEntropyTracker()
    t.record('bash', { cmd: 'ls' }, false)
    expect(t.currentScore).toBe(2.0)
  })

  test('unique success lowers score by 1.5, floor is 0', () => {
    const t = new AgentEntropyTracker()
    t.record('bash', { cmd: 'ls' }, true)
    expect(t.currentScore).toBe(0) // floored at 0
  })

  test('repeated success raises score by 0.5', () => {
    const t = new AgentEntropyTracker()
    t.record('bash', { cmd: 'ls' }, true)  // unique: 0 - 1.5 = 0 (floor)
    t.record('bash', { cmd: 'ls' }, true)  // repeated: 0 + 0.5 = 0.5
    expect(t.currentScore).toBeCloseTo(0.5)
  })

  test('ejects at score >= 10', () => {
    const t = new AgentEntropyTracker()
    // 5 failures × 2.0 = 10.0 → eject
    let ejected = false
    for (let i = 0; i < 4; i++) ejected = t.record('bad', {}, false)
    expect(ejected).toBe(false)
    ejected = t.record('bad', {}, false)
    expect(ejected).toBe(true)
  })

  test('unique successes after failures lower score below threshold', () => {
    const t = new AgentEntropyTracker()
    // 4 failures → score 8.0
    for (let i = 0; i < 4; i++) t.record('bad', {}, false)
    expect(t.currentScore).toBe(8.0)
    // 6 unique successes × -1.5 = -9.0, floored; score → 0
    for (let i = 0; i < 6; i++) t.record('good', { i }, true)
    expect(t.currentScore).toBe(0)
    expect(t.record('bad', {}, false)).toBe(false) // score 2.0, no eject
  })

  test('reset clears score and seen set', () => {
    const t = new AgentEntropyTracker()
    for (let i = 0; i < 4; i++) t.record('bad', {}, false)
    t.reset()
    expect(t.currentScore).toBe(0)
    // After reset, same call is unique again
    t.record('bash', { cmd: 'ls' }, true)
    expect(t.currentScore).toBe(0) // unique success, floored
    t.record('bash', { cmd: 'ls' }, true)
    expect(t.currentScore).toBeCloseTo(0.5) // repeated now
  })

  test('call signature includes args — different args are distinct', () => {
    const t = new AgentEntropyTracker()
    t.record('bash', { cmd: 'ls' }, true)    // unique: score 0
    t.record('bash', { cmd: 'pwd' }, true)   // different args = unique: score 0
    t.record('bash', { cmd: 'ls' }, true)    // same as first = repeated: score 0.5
    expect(t.currentScore).toBeCloseTo(0.5)
  })
})
