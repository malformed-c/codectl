/**
 * LLM provider protocol and configuration types.
 *
 * Ported from yodoca/core/llm/protocol.py.
 *
 * Separates provider-level config (base URL, auth) from per-agent model
 * config (which model, temperature, token budget). The ModelRouter bridges
 * the two and returns ready-to-use LLMAdapter instances.
 */

import type { LLMAdapter } from '../orchestrator'

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** Per-agent model configuration — from config.yaml agents.* or manifest. */
export type ModelConfig = {
  /** Provider id that should serve this agent (matches a key in providers). */
  provider: string
  /** Model name/identifier to pass to the provider. */
  model: string
  temperature?: number
  maxTokens?: number
  /** Arbitrary extra parameters forwarded verbatim to the provider build(). */
  extra?: Record<string, unknown>
}

/** Provider-level configuration — from config.yaml providers.*. */
export type ProviderConfig = {
  id: string
  /** Determines which ModelProvider implementation handles this config. */
  type: string
  baseUrl?: string
  /**
   * Name of an environment variable that holds the API key.
   * Resolved at build time via the secrets getter.
   */
  apiKeySecret?: string
  /** Literal API key — takes priority over apiKeySecret. */
  apiKeyLiteral?: string
  /**
   * Multiple env var names for key-pool rotation (e.g. Gemini free-tier quota).
   * Resolved at build time; all non-empty values are passed to the adapter's KeyPool.
   * Takes priority over apiKeySecret when present.
   */
  apiKeySecrets?: string[]
  /** Multiple literal keys for key-pool rotation. Takes priority over apiKeySecrets. */
  apiKeyLiterals?: string[]
  defaultHeaders?: Record<string, string>
  /**
   * Set false for local/third-party providers that don't support OpenAI
   * hosted tool types (web_search_preview, computer_use_preview, etc.).
   */
  supportsHostedTools?: boolean
}

// ---------------------------------------------------------------------------
// Capability protocol
// ---------------------------------------------------------------------------

/**
 * Typed capability handle returned by ModelProvider.getCapability().
 *
 * Define sub-interfaces for specific capabilities, e.g.:
 *   interface EmbeddingCapability { embed(texts: string[]): Promise<number[][]> }
 *
 * Then call router.getCapability(EmbeddingCapabilitySymbol) to retrieve it.
 */
export type CapabilityKey<T> = { readonly _cap: T }

export function defineCapability<T>(): CapabilityKey<T> {
  return {} as CapabilityKey<T>
}

// ---------------------------------------------------------------------------
// ModelProvider interface
// ---------------------------------------------------------------------------

export interface ModelProvider {
  readonly providerType: string

  /**
   * Build and return a configured LLMAdapter for this provider.
   * Called once per (provider, model) pair and cached by the router.
   */
  build(config: ProviderConfig, modelName: string, apiKey: string | string[] | null): LLMAdapter

  /** Optional liveness check — returns true if the provider is reachable. */
  healthCheck?(config: ProviderConfig, apiKey: string | string[] | null): Promise<boolean>

  /**
   * Return a capability instance if this provider supports it, else null.
   * cap is a CapabilityKey created with defineCapability<T>().
   */
  getCapability?<T>(cap: CapabilityKey<T>, config: ProviderConfig, apiKey: string | string[] | null): T | null
}
