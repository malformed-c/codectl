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
import { GeminiNativeAdapter, GeminiInteractionsAdapter } from '../../gemini'
import { Profiles } from '../../template'

type TemplateProfileName = keyof typeof Profiles

function resolveTemplateProfile(config: ProviderConfig, fallback: TemplateProfileName): (typeof Profiles)[TemplateProfileName] {
  const raw = typeof (config as any).template_profile === 'string'
    ? ((config as any).template_profile as string).trim()
    : ''

  if (!raw) return Profiles[fallback]

  const normalized = raw.toLowerCase()
  const map: Record<string, TemplateProfileName> = {
    mistral: 'mistral',
    llama3: 'llama3',
    qwen: 'qwen',
    qwenxml: 'qwenXml',
    'qwen-xml': 'qwenXml',
    deepseek: 'deepseek',
    chatml: 'chatml',
  }
  const key = map[normalized]

  return key ? Profiles[key] : Profiles[fallback]
}

// ---------------------------------------------------------------------------
// KoboldCPP provider
// ---------------------------------------------------------------------------

export class KoboldProvider implements ModelProvider {
  readonly providerType = 'koboldcpp'

  build(config: ProviderConfig, _modelName: string, _apiKey: string | string[] | null): LLMAdapter {
    return new KoboldAdapter({
      apiServer: config.baseUrl ?? 'http://127.0.0.1:5001/api',
      template: resolveTemplateProfile(config, 'mistral'),
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

  build(config: ProviderConfig, modelName: string, apiKey: string | string[] | null): LLMAdapter {
    return new OpenAIChatAdapter({
      apiServer: config.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? '',
      model: modelName,
      template: Profiles.qwen,
    })
  }

  async healthCheck(config: ProviderConfig, apiKey: string | string[] | null): Promise<boolean> {
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

  build(config: ProviderConfig, modelName: string, apiKey: string | string[] | null): LLMAdapter {
    return new OpenAITextAdapter({
      apiServer: config.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? '',
      model: modelName,
      template: Profiles.qwen,
    })
  }
}

// ---------------------------------------------------------------------------
// Gemini providers
// ---------------------------------------------------------------------------

export class GeminiNativeProvider implements ModelProvider {
  readonly providerType = 'gemini-native'

  build(config: ProviderConfig, modelName: string, apiKey: string | string[] | null): LLMAdapter {
    const isGemini3 = modelName.startsWith('gemini-3') || modelName.startsWith('gemini-2.5')

    return new GeminiNativeAdapter({
      apiKey: apiKey ?? '',
      model: modelName,
      template: Profiles.qwen,
      thinking: isGemini3,
      thinkingLevel: 'low',
    })
  }
}

export class GeminiInteractionsProvider implements ModelProvider {
  readonly providerType = 'gemini-interactions'

  build(config: ProviderConfig, modelName: string, apiKey: string | string[] | null): LLMAdapter {
    return new GeminiInteractionsAdapter({
      apiKey: apiKey ?? '',
      model: modelName,
      template: Profiles.qwen,
    })
  }
}
