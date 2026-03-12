import consola from 'consola'
import { parse, render } from './template'
import type { Message, TextTemplate, ParsedTurn } from './template'

// --- Shared types ---

export type OpenAIConfig = {
  apiServer: string
  apiKey: string
  model: string
  template: TextTemplate

  // Sampling
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  streaming?: boolean

  // Override the chat completions path (e.g. Gemini OpenAI-compat endpoint)
  completionsPath?: string
}

export type OpenAIStatus = {
  model: string
}

export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'OpenAIError'
  }
}

// --- Shared helpers ---

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function buildStopSequences(cfg: OpenAIConfig): string[] {
  const stops: string[] = [...(cfg.stopSequences ?? [])]

  if (cfg.template.eos) stops.push(cfg.template.eos)

  return [...new Set(stops)]
}

// --- OpenAI Chat Adapter ---
// Uses /v1/chat/completions - passes messages as structured objects.

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function toChatMessages(messages: Message[]): ChatMessage[] {
  return messages.map((m) => {
    const role =
      m.role === 'system' ? 'system' : m.role === 'user' ? 'user' : 'assistant'

    return { role, content: m.content }
  })
}

export class OpenAIChatAdapter {
  readonly config: OpenAIConfig
  private readonly server: string
  private readonly completionsPath: string

  constructor(config: OpenAIConfig) {
    this.config = config
    this.server = config.apiServer.replace(/\/+$/, '').replace(/\/v\d+$/, '')
    this.completionsPath = config.completionsPath ?? '/v1/chat/completions'
  }

  async status(): Promise<OpenAIStatus> {
    return { model: this.config.model }
  }

  async generate(messages: Message[]): Promise<ParsedTurn> {
    const chatMsgs = toChatMessages(messages)
    const raw = await this.chatComplete(chatMsgs)

    return parse(raw, this.config.template)
  }

  /** generateRaw: send pre-rendered prompt as a single user message. */
  async generateRaw(prompt: string): Promise<ParsedTurn> {
    const raw = await this.chatComplete([{ role: 'user', content: prompt }])

    return parse(raw, this.config.template)
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const chatMsgs = toChatMessages(messages)
    yield* this.streamChatComplete(chatMsgs)
  }

  async *streamRaw(prompt: string): AsyncGenerator<string> {
    yield* this.streamChatComplete([{ role: 'user', content: prompt }])
  }

  // --- Internals ---

  private buildPayload(messages: ChatMessage[], streaming: boolean): Record<string, unknown> {
    return {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: this.config.temperature ?? 0.7,
      top_p: this.config.topP ?? 0.95,
      stop: buildStopSequences(this.config),
      stream: streaming,
    }
  }

  private async chatComplete(messages: ChatMessage[], retries = 3): Promise<string> {
    const url = `${this.server}${this.completionsPath}`
    const body = this.buildPayload(messages, false)

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: authHeaders(this.config.apiKey),
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const text = await response.text()

          throw new OpenAIError(text, response.status)
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>
        }

        return data.choices?.[0]?.message?.content ?? ''

      } catch (err) {
        if (err instanceof OpenAIError && err.status && err.status < 500) throw err

        if (i < retries - 1) { await delay(2500); continue }

        throw err
      }
    }

    throw new OpenAIError('Max retries exceeded')
  }

  private async *streamChatComplete(messages: ChatMessage[]): AsyncGenerator<string> {
    const url = `${this.server}${this.completionsPath}`
    const body = this.buildPayload(messages, true)

    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(this.config.apiKey),
      body: JSON.stringify(body),
    })

    if (!response.ok || !response.body) {
      throw new OpenAIError(`Stream failed: ${response.status}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()

        if (payload === '[DONE]') return

        try {
          const data = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
          }
          const token = data.choices?.[0]?.delta?.content

          if (token) yield token
        } catch { /* malformed SSE line */ }
      }
    }
  }
}

// --- OpenAI Text Adapter ---
// Uses /v1/completions - renders messages to a prompt string first.

export class OpenAITextAdapter {
  readonly config: OpenAIConfig
  private readonly server: string

  constructor(config: OpenAIConfig) {
    this.config = config
    this.server = config.apiServer.replace(/\/+$/, '').replace(/\/v\d+$/, '')
  }

  async status(): Promise<OpenAIStatus> {
    return { model: this.config.model }
  }

  async generate(messages: Message[]): Promise<ParsedTurn> {
    const prompt = render(messages, this.config.template)

    return this.generateRaw(prompt)
  }

  async generateRaw(prompt: string): Promise<ParsedTurn> {
    const raw = await this.textComplete(prompt)

    return parse(raw, this.config.template)
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const prompt = render(messages, this.config.template)
    yield* this.streamRaw(prompt)
  }

  async *streamRaw(prompt: string): AsyncGenerator<string> {
    yield* this.streamTextComplete(prompt)
  }

  // --- Internals ---

  private buildPayload(prompt: string, streaming: boolean): Record<string, unknown> {
    return {
      model: this.config.model,
      prompt,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: this.config.temperature ?? 0.7,
      top_p: this.config.topP ?? 0.95,
      stop: buildStopSequences(this.config),
      stream: streaming,
    }
  }

  private async textComplete(prompt: string, retries = 3): Promise<string> {
    const url = `${this.server}/v1/completions`
    const body = this.buildPayload(prompt, false)

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: authHeaders(this.config.apiKey),
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const text = await response.text()

          throw new OpenAIError(text, response.status)
        }

        const data = await response.json() as {
          choices?: Array<{ text?: string }>
        }

        return data.choices?.[0]?.text ?? ''

      } catch (err) {
        if (err instanceof OpenAIError && err.status && err.status < 500) throw err

        if (i < retries - 1) { await delay(2500); continue }

        throw err
      }
    }

    throw new OpenAIError('Max retries exceeded')
  }

  private async *streamTextComplete(prompt: string): AsyncGenerator<string> {
    const url = `${this.server}/v1/completions`
    const body = this.buildPayload(prompt, true)

    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(this.config.apiKey),
      body: JSON.stringify(body),
    })

    if (!response.ok || !response.body) {
      throw new OpenAIError(`Stream failed: ${response.status}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()

        if (payload === '[DONE]') return

        try {
          const data = JSON.parse(payload) as {
            choices?: Array<{ text?: string }>
          }
          const token = data.choices?.[0]?.text

          if (token) yield token
        } catch { /* malformed SSE line */ }
      }
    }
  }
}

// --- Smoke test ---

if (import.meta.main) {
  const { Profiles } = await import('./template')

  const apiKey = Bun.env.OPENAI_API_KEY ?? ''
  const apiServer = Bun.env.BASE_URL ?? 'https://api.openai.com'
  const model = Bun.env.MODEL ?? 'gpt-4o-mini'

  consola.log('=== OpenAIChatAdapter ===')
  const chat = new OpenAIChatAdapter({
    apiServer,
    apiKey,
    model,
    template: Profiles.qwen,
    maxTokens: 200,
  })
  const chatResult = await chat.generate([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hello in one sentence.' },
  ])
  consola.log(chatResult)

  consola.log('\n=== OpenAITextAdapter ===')
  const text = new OpenAITextAdapter({
    apiServer,
    apiKey,
    model,
    template: Profiles.qwen,
    maxTokens: 200,
  })
  const textResult = await text.generate([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hello in one sentence.' },
  ])
  consola.log(textResult)
}
