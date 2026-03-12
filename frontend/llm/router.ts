/**
 * ModelRouter: config-driven adapter factory.
 *
 * Ported from yodoca/core/llm/router.py.
 *
 * Bridges ProviderConfig + ModelConfig → LLMAdapter.
 * Instances are cached after first build; call invalidate() after hot-reload.
 *
 * Usage:
 *   const router = ModelRouter.fromConfig(config, (name) => process.env[name])
 *   const adapter = router.getAdapter('orchestrator')  // or 'default'
 */

import consola from 'consola'
import type { LLMAdapter } from '../orchestrator'
import type { ModelConfig, ProviderConfig, ModelProvider, CapabilityKey } from './protocol'
import { KoboldProvider, OpenAIChatProvider, OpenAITextProvider, GeminiNativeProvider, GeminiInteractionsProvider } from './providers/builtin'

// ---------------------------------------------------------------------------
// Config shape (subset of config.yaml)
// ---------------------------------------------------------------------------

export type RouterSettings = {
  providers?: Record<string, ProviderSettings>
  agents?: Record<string, AgentSettings>
}

type ProviderSettings = {
  type?: string
  base_url?: string
  api_key_secret?: string
  api_key_literal?: string
  /** List of env var names for key-pool rotation. */
  api_key_secrets?: string[]
  /** List of literal keys for key-pool rotation. */
  api_key_literals?: string[]
  default_headers?: Record<string, string>
  supports_hosted_tools?: boolean
  [key: string]: unknown
}

type AgentSettings = {
  provider?: string
  model?: string
  temperature?: number
  max_tokens?: number
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

export class ModelRouter {
  private readonly providerConfigs = new Map<string, ProviderConfig>()
  private readonly agentConfigs    = new Map<string, ModelConfig>()
  private readonly providers       = new Map<string, ModelProvider>()
  private readonly cache           = new Map<string, LLMAdapter>()
  private readonly secrets: (name: string) => string | undefined

  constructor(secrets: (name: string) => string | undefined = (n) => process.env[n]) {
    this.secrets = secrets
    this._registerDefaults()
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  static fromConfig(
    settings: RouterSettings,
    secrets: (name: string) => string | undefined = (n) => process.env[n],
  ): ModelRouter {
    const router = new ModelRouter(secrets)
    router._load(settings)

    return router
  }

  /**
   * Convenience: build a single-provider router from the flat env/config
   * variables codectl has always used. Keeps index.ts backwards compatible.
   */
  static fromLegacyEnv(opts: {
    apiType: string
    apiServer: string
    apiKey: string
    model: string
  }): ModelRouter {
    const router = new ModelRouter()
    const parts = opts.apiKey.split(',').map(s => s.trim()).filter(Boolean)
    router.registerProviderConfig({
      id: 'default',
      type: opts.apiType,
      baseUrl: opts.apiServer,
      ...(parts.length > 1 ? { apiKeyLiterals: parts } : { apiKeyLiteral: parts[0] ?? '' }),
    })
    router.registerAgentConfig('default', {
      provider: 'default',
      model: opts.model,
    })

    return router
  }

  // ---------------------------------------------------------------------------
  // Config registration
  // ---------------------------------------------------------------------------

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.providerType, provider)
  }

  registerProviderConfig(config: ProviderConfig): void {
    this.providerConfigs.set(config.id, config)
  }

  registerAgentConfig(agentId: string, config: ModelConfig): void {
    // settings.yaml takes priority — only register if not already configured
    if (!this.agentConfigs.has(agentId)) {
      this.agentConfigs.set(agentId, config)
    }
  }

  removeAgentConfig(agentId: string): void {
    this.agentConfigs.delete(agentId)
    this.cache.delete(agentId)
  }

  // ---------------------------------------------------------------------------
  // Adapter resolution
  // ---------------------------------------------------------------------------

  /**
   * Return a cached or newly built LLMAdapter for the given agent.
   * Falls back to 'default' if agentId has no dedicated config.
   */
  getAdapter(agentId = 'default'): LLMAdapter {
    if (this.cache.has(agentId)) return this.cache.get(agentId)!

    const agentCfg = this.agentConfigs.get(agentId) ?? this.agentConfigs.get('default')

    if (!agentCfg) {
      throw new Error(
        `No model config for agent=${agentId} and no 'default' agent in config`
      )
    }

    const providerCfg = this.providerConfigs.get(agentCfg.provider)

    if (!providerCfg) {
      throw new Error(
        `Unknown provider '${agentCfg.provider}' for agent=${agentId}`
      )
    }

    const provider = this.providers.get(providerCfg.type)

    if (!provider) {
      throw new Error(
        `Unknown provider type '${providerCfg.type}' for provider id '${providerCfg.id}'`
      )
    }

    const apiKey = this._resolveKey(providerCfg)
    const adapter = provider.build(providerCfg, agentCfg.model, apiKey)

    this.cache.set(agentId, adapter)

    return adapter
  }

  getDefaultProvider(): string | undefined {
    return this.agentConfigs.get('default')?.provider
  }

  supportsHostedTools(agentId = 'default'): boolean {
    const agentCfg = this.agentConfigs.get(agentId) ?? this.agentConfigs.get('default')

    if (!agentCfg) return true
    const providerCfg = this.providerConfigs.get(agentCfg.provider)

    return providerCfg?.supportsHostedTools ?? true
  }

  // ---------------------------------------------------------------------------
  // Capability resolution
  // ---------------------------------------------------------------------------

  /**
   * Ask a provider whether it supports a typed capability.
   *
   * Example:
   *   const embed = router.getCapability(EmbeddingCapKey, 'openai')
   *   if (embed) await embed.embed(['hello'])
   */
  getCapability<T>(cap: CapabilityKey<T>, providerId?: string): T | null {
    const candidates = providerId
      ? [providerId]
      : [...this.providerConfigs.keys()]

    for (const pid of candidates) {
      const pcfg = this.providerConfigs.get(pid)

      if (!pcfg) continue
      const provider = this.providers.get(pcfg.type)

      if (!provider?.getCapability) continue
      const key = this._resolveKey(pcfg)
      const result = provider.getCapability(cap, pcfg, key)

      if (result !== null && result !== undefined) return result
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Health checks
  // ---------------------------------------------------------------------------

  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}

    for (const [pid, pcfg] of this.providerConfigs) {
      const provider = this.providers.get(pcfg.type)

      if (!provider?.healthCheck) { results[pid] = true; continue }
      const key = this._resolveKey(pcfg)

      try {
        results[pid] = await provider.healthCheck(pcfg, key)

      } catch (err) {
        consola.debug(`[ModelRouter] healthCheck ${pid} failed:`, err)
        results[pid] = false
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Cache invalidation
  // ---------------------------------------------------------------------------

  invalidate(agentId?: string): void {
    if (agentId) {
      this.cache.delete(agentId)

    } else {
      this.cache.clear()
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _load(settings: RouterSettings): void {
    for (const [pid, pdata] of Object.entries(settings.providers ?? {})) {
      this.registerProviderConfig({
        id: pid,
        type: pdata.type ?? 'openai-chat',
        baseUrl: pdata.base_url,
        apiKeySecret: pdata.api_key_secret,
        apiKeyLiteral: pdata.api_key_literal,
        apiKeySecrets: pdata.api_key_secrets,
        apiKeyLiterals: pdata.api_key_literals,
        defaultHeaders: pdata.default_headers,
        supportsHostedTools: pdata.supports_hosted_tools,
      })
    }

    for (const [aid, adata] of Object.entries(settings.agents ?? {})) {
      if (adata.provider) {
        this.registerAgentConfig(aid, {
          provider: adata.provider,
          model: adata.model ?? '',
          temperature: adata.temperature,
          maxTokens: adata.max_tokens,
          extra: adata.extra,
        })
      }
    }
  }

  private _registerDefaults(): void {
    this.registerProvider(new KoboldProvider())
    this.registerProvider(new OpenAIChatProvider())
    this.registerProvider(new OpenAITextProvider())
    this.registerProvider(new GeminiNativeProvider())
    this.registerProvider(new GeminiInteractionsProvider())
  }

  private _resolveKey(cfg: ProviderConfig): string | string[] | null {
    if (cfg.apiKeyLiterals?.length) return cfg.apiKeyLiterals

    if (cfg.apiKeyLiteral) return cfg.apiKeyLiteral

    if (cfg.apiKeySecrets?.length) {
      const resolved = cfg.apiKeySecrets.map(n => this.secrets(n)).filter((v): v is string => !!v)

      if (resolved.length) return resolved.length === 1 ? resolved[0]! : resolved
    }

    if (cfg.apiKeySecret) {
      const val = this.secrets(cfg.apiKeySecret)

      if (!val) return null
      // Comma-separated value → key pool (e.g. GEMINI_API_KEYS=key1,key2,key3)
      const parts = val.split(',').map(s => s.trim()).filter(Boolean)

      return parts.length > 1 ? parts : parts[0] ?? null
    }

    return null
  }
}
