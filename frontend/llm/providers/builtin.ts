/**
 * Built-in ModelProvider implementations.
 *
 * Each wraps an existing adapter constructor and implements the ModelProvider
 * interface so the ModelRouter can build adapters from config alone.
 */

import type { ModelProvider, ProviderConfig } from '../protocol'
import type { LLMAdapter } from '../../orchestrator'
import { KoboldAdapter } from '../../kobold'
import { OpenAIChatAdapter, OpenAITextAdapter } from '../../openai'
import { Profiles } from '../../template'

// ---------------------------------------------------------------------------
// KoboldCPP provider
// ---------------------------------------------------------------------------

export class KoboldProvider implements ModelProvider {
  readonly providerType = 'koboldcpp'

  build(config: ProviderConfig, _modelName: string, _apiKey: string | null): LLMAdapter {
    return new KoboldAdapter({
      apiServer: config.baseUrl ?? 'http://127.0.0.1:5001/api',
      template: Profiles.mistral,
    })
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? 'http://127.0.0.1:5001'}/api/v1/info`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible providers
// ---------------------------------------------------------------------------

export class OpenAIChatProvider implements ModelProvider {
  readonly providerType = 'openai-chat'

  build(config: ProviderConfig, modelName: string, apiKey: string | null): LLMAdapter {
    return new OpenAIChatAdapter({
      apiServer: config.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: apiKey ?? '',
      model: modelName,
      template: Profiles.qwen,
    })
  }

  async healthCheck(config: ProviderConfig, apiKey: string | null): Promise<boolean> {
    try {
      const url = `${config.baseUrl ?? 'https://api.openai.com/v1'}/models`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

export class OpenAITextProvider implements ModelProvider {
  readonly providerType = 'openai-text'

  build(config: ProviderConfig, modelName: string, apiKey: string | null): LLMAdapter {
    return new OpenAITextAdapter({
      apiServer: config.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: apiKey ?? '',
      model: modelName,
      template: Profiles.qwen,
    })
  }
}
