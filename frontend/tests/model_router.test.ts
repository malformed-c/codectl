import { describe, expect, test } from 'bun:test'
import { ModelRouter } from '../llm/router'
import type { ModelProvider, ProviderConfig } from '../llm/protocol'
import { defineCapability } from '../llm/protocol'
import type { LLMAdapter } from '../orchestrator'
import { KoboldAdapter } from '../kobold'
import { Profiles } from '../template'

// ---------------------------------------------------------------------------
// Stub provider
// ---------------------------------------------------------------------------

/** Records calls for inspection. Returns a KoboldAdapter as a placeholder LLMAdapter. */
class StubProvider implements ModelProvider {
  readonly providerType: string
  readonly built: Array<{ config: ProviderConfig; modelName: string; apiKey: string | null }> = []
  readonly healthResults: boolean[]

  constructor(type = 'stub', healthResults: boolean[] = [true]) {
    this.providerType = type
    this.healthResults = healthResults
  }

  build(config: ProviderConfig, modelName: string, apiKey: string | null): LLMAdapter {
    this.built.push({ config, modelName, apiKey })
    return new KoboldAdapter({ apiServer: 'http://localhost', template: Profiles.mistral })
  }

  async healthCheck(_config: ProviderConfig, _apiKey: string | null): Promise<boolean> {
    return this.healthResults.shift() ?? true
  }
}

// ---------------------------------------------------------------------------
// fromLegacyEnv
// ---------------------------------------------------------------------------

describe('ModelRouter.fromLegacyEnv', () => {
  test('builds adapter via koboldcpp provider', () => {
    const router = ModelRouter.fromLegacyEnv({
      apiType: 'koboldcpp',
      apiServer: 'http://localhost:5001',
      apiKey: '',
      model: 'mistral',
    })
    // Should not throw
    const adapter = router.getAdapter()
    expect(adapter).toBeDefined()
  })

  test('builds adapter via openai-chat provider', () => {
    const router = ModelRouter.fromLegacyEnv({
      apiType: 'openai-chat',
      apiServer: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    })
    const adapter = router.getAdapter()
    expect(adapter).toBeDefined()
  })

  test('builds adapter via openai-text provider', () => {
    const router = ModelRouter.fromLegacyEnv({
      apiType: 'openai-text',
      apiServer: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-3.5-turbo-instruct',
    })
    const adapter = router.getAdapter()
    expect(adapter).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// fromConfig
// ---------------------------------------------------------------------------

describe('ModelRouter.fromConfig', () => {
  test('loads providers and agents from settings shape', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: {
        myProvider: { type: 'openai-chat', base_url: 'https://api.openai.com/v1', api_key_literal: 'sk-x' },
      },
      agents: {
        default: { provider: 'myProvider', model: 'gpt-4o' },
      },
    })
    router.registerProvider(stub)
    const adapter = router.getAdapter('default')
    expect(adapter).toBeDefined()
    expect(stub.built).toHaveLength(1)
    expect(stub.built[0]!.modelName).toBe('gpt-4o')
    expect(stub.built[0]!.apiKey).toBe('sk-x')
  })

  test('resolves api_key_secret via secrets getter', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig(
      {
        providers: {
          p: { type: 'openai-chat', api_key_secret: 'MY_API_KEY' },
        },
        agents: {
          default: { provider: 'p', model: 'gpt-4o' },
        },
      },
      (name) => name === 'MY_API_KEY' ? 'resolved-key' : undefined,
    )
    router.registerProvider(stub)
    router.getAdapter()
    expect(stub.built[0]!.apiKey).toBe('resolved-key')
  })

  test('api_key_literal takes priority over api_key_secret', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig(
      {
        providers: {
          p: { type: 'openai-chat', api_key_secret: 'ENV_KEY', api_key_literal: 'literal-key' },
        },
        agents: { default: { provider: 'p', model: 'm' } },
      },
      () => 'from-env',
    )
    router.registerProvider(stub)
    router.getAdapter()
    expect(stub.built[0]!.apiKey).toBe('literal-key')
  })

  test('falls back to default agent config when specific agentId is missing', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'default-model' } },
    })
    router.registerProvider(stub)
    const adapter = router.getAdapter('nonexistent-agent')
    expect(adapter).toBeDefined()
    expect(stub.built[0]!.modelName).toBe('default-model')
  })

  test('throws for unknown provider', () => {
    const router = ModelRouter.fromConfig({
      providers: {},
      agents: { default: { provider: 'missing', model: 'm' } },
    })
    expect(() => router.getAdapter()).toThrow(/Unknown provider/)
  })

  test('throws for unknown provider type', () => {
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'not-a-real-type', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    expect(() => router.getAdapter()).toThrow(/Unknown provider type/)
  })

  test('throws when no config found for agentId and no default', () => {
    const router = new ModelRouter()
    expect(() => router.getAdapter('missing')).toThrow(/No model config/)
  })
})

// ---------------------------------------------------------------------------
// Caching and invalidation
// ---------------------------------------------------------------------------

describe('ModelRouter - caching', () => {
  test('getAdapter returns the same instance on subsequent calls', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(stub)

    const a1 = router.getAdapter()
    const a2 = router.getAdapter()
    expect(a1).toBe(a2)
    expect(stub.built).toHaveLength(1)
  })

  test('invalidate() forces rebuild on next call', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(stub)

    router.getAdapter()
    router.invalidate('default')
    router.getAdapter()

    expect(stub.built).toHaveLength(2)
  })

  test('invalidate() without args clears all cached adapters', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: {
        default: { provider: 'p', model: 'm' },
        other:   { provider: 'p', model: 'm2' },
      },
    })
    router.registerProvider(stub)

    router.getAdapter('default')
    router.getAdapter('other')
    router.invalidate()
    router.getAdapter('default')
    router.getAdapter('other')

    expect(stub.built).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// registerAgentConfig respects settings.yaml priority
// ---------------------------------------------------------------------------

describe('ModelRouter.registerAgentConfig', () => {
  test('settings.yaml config takes priority over runtime registration', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'from-yaml' } },
    })
    router.registerProvider(stub)

    // Try to override — should be ignored
    router.registerAgentConfig('default', { provider: 'p', model: 'from-code' })
    router.getAdapter()

    expect(stub.built[0]!.modelName).toBe('from-yaml')
  })

  test('removeAgentConfig allows re-registration', () => {
    const stub = new StubProvider('openai-chat')
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'original' } },
    })
    router.registerProvider(stub)

    router.removeAgentConfig('default')
    router.registerAgentConfig('default', { provider: 'p', model: 'replaced' })
    router.getAdapter()

    expect(stub.built[0]!.modelName).toBe('replaced')
  })
})

// ---------------------------------------------------------------------------
// Capability protocol
// ---------------------------------------------------------------------------

describe('ModelRouter - getCapability', () => {
  interface EmbeddingCap { embed(texts: string[]): number[][] }
  const EmbeddingKey = defineCapability<EmbeddingCap>()

  test('returns capability when provider supports it', () => {
    const mockEmbed: EmbeddingCap = { embed: (t) => t.map(() => [0, 1, 2]) }

    const capProvider: ModelProvider = {
      providerType: 'cap-provider',
      build: () => new KoboldAdapter({ apiServer: 'http://localhost', template: Profiles.mistral }),
      getCapability: <T>(cap: any, _cfg: any, _key: any): T | null => {
        if (cap === EmbeddingKey) return mockEmbed as T
        return null
      },
    }

    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'cap-provider', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(capProvider)

    const cap = router.getCapability(EmbeddingKey)
    expect(cap).toBe(mockEmbed)
    expect(cap!.embed(['hello'])).toEqual([[0, 1, 2]])
  })

  test('returns null when no provider supports capability', () => {
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'koboldcpp', base_url: 'http://localhost' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    const cap = router.getCapability(EmbeddingKey)
    expect(cap).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

describe('ModelRouter - healthCheckAll', () => {
  test('returns true for healthy providers', async () => {
    const stub = new StubProvider('openai-chat', [true])
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(stub)

    const results = await router.healthCheckAll()
    expect(results['p']).toBe(true)
  })

  test('returns false for unhealthy providers', async () => {
    const stub = new StubProvider('openai-chat', [false])
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'openai-chat', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(stub)

    const results = await router.healthCheckAll()
    expect(results['p']).toBe(false)
  })

  test('returns true for providers without healthCheck', async () => {
    // KoboldProvider has healthCheck but we'll register a minimal stub
    const minimalProvider: ModelProvider = {
      providerType: 'minimal',
      build: () => new KoboldAdapter({ apiServer: 'http://localhost', template: Profiles.mistral }),
      // no healthCheck method
    }
    const router = ModelRouter.fromConfig({
      providers: { p: { type: 'minimal', api_key_literal: 'k' } },
      agents: { default: { provider: 'p', model: 'm' } },
    })
    router.registerProvider(minimalProvider)

    const results = await router.healthCheckAll()
    expect(results['p']).toBe(true)
  })
})
