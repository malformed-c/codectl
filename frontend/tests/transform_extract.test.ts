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

    expect((out.ok ? undefined : out.error)).toBeUndefined()
    expect(out.value).toBe('Alice')
  })

  test('json path "." returns full root object', async () => {
    const memory = new MockMemory()
    const history: SerializedRound[] = [
      {
        kind: 'chat',
        id: 'c1',
        user: [{ kind: 'user', text: '{"codePlan":[{"kind":"Ansible"}]}' }],
        model: '',
      },
    ]

    const handler = createExtractHandler(memory, { getCommitted: () => history })
    const out = await handler({ method: 'json', turn: 0, path: '.' })

    expect((out.ok ? undefined : out.error)).toBeUndefined()
    const parsed = JSON.parse(out.value as string)
    expect(parsed).toHaveProperty('codePlan')
    expect(parsed.codePlan[0].kind).toBe('Ansible')
  })

  test('json path "." saves to memory', async () => {
    const memory = new MockMemory()
    const history: SerializedRound[] = [
      {
        kind: 'chat',
        id: 'c1',
        user: [{ kind: 'user', text: '{"x":1}' }],
        model: '',
      },
    ]

    const handler = createExtractHandler(memory, { getCommitted: () => history })
    const out = await handler({ method: 'json', turn: 0, path: '.', save_to: 'whole' })

    expect((out.ok ? undefined : out.error)).toBeUndefined()
    expect(memory.get('whole')).toBe('{"x":1}')
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

    expect((out.ok ? undefined : out.error)).toBeUndefined()
    expect(out.value).toContain('"timeout": 30')
  })
})

describe('extract tool bracket notation', () => {
  test('json path with bracket notation resolves array element', async () => {
    const memory = new MockMemory()
    const history: SerializedRound[] = [
      {
        kind: 'chat',
        id: 'c1',
        user: [{ kind: 'user', text: '{"codePlan":[{"spec":{"tasks":[{"args":{"dest":"/tmp/hello.txt"}}]}}]}' }],
        model: '',
      },
    ]

    const handler = createExtractHandler(memory, { getCommitted: () => history })
    const out = await handler({ method: 'json', turn: 0, path: 'codePlan[0].spec.tasks[0].args.dest' })

    expect((out.ok ? undefined : out.error)).toBeUndefined()
    expect(out.value).toBe('/tmp/hello.txt')
  })
})
