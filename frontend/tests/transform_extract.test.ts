import { describe, expect, test } from 'bun:test'
import { createExtractHandler } from '../tools/transform'
import type { SerializedRound } from '../round'

class MockMemory {
  private readonly data = new Map<string, string>()

  get(key: string): string | undefined { return this.data.get(key) }
  set(key: string, value: string): void { this.data.set(key, value) }
  has(key: string): boolean { return this.data.has(key) }
}

describe('extract tool turn offsets', () => {
  test('reads latest user message from agent trigger turn', async () => {
    const memory = new MockMemory()
    const history: SerializedRound[] = [
      {
        kind: 'agent',
        id: 'a1',
        trigger: [{ kind: 'user', text: '{"users":[{"name":"Alice"}]}' }],
        rounds: [],
        response: 'ok',
      },
    ]

    const handler = createExtractHandler(memory, { getCommitted: () => history })
    const out = await handler({ method: 'json', turn: 0, path: 'users.0.name' })

    expect(out.error).toBeUndefined()
    expect(out.result).toBe('Alice')
  })

  test('codeblocks fallback accepts raw JSON without fences', async () => {
    const memory = new MockMemory()
    const history: SerializedRound[] = [
      {
        kind: 'chat',
        id: 'c1',
        user: [{ kind: 'user', text: '{\n  "config": { "timeout": 30 }\n}' }],
        model: '',
      },
    ]

    const handler = createExtractHandler(memory, { getCommitted: () => history })
    const out = await handler({ method: 'codeblocks', turn: 0, lang: 'json', index: 0 })

    expect(out.error).toBeUndefined()
    expect(out.result).toContain('"timeout": 30')
  })
})
