import consola from 'consola'
import { GoogleGenAI, ThinkingLevel, type Interactions } from '@google/genai'
import { parse, makeTurn } from './template'
import type { Message, TextTemplate, ParsedTurn } from './template'
import { OpenAIChatAdapter } from './openai'

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

export type GeminiConfig = {
  apiKey: string
  model: string
  template: TextTemplate
  maxTokens?: number
  temperature?: number
  topP?: number
  thinking?: boolean
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
}

// ---------------------------------------------------------------------------
// GeminiOpenAIAdapter
// Thin wrapper over OpenAIChatAdapter using Gemini's OpenAI-compat endpoint.
// Only a subset of models are available on this endpoint.
// ---------------------------------------------------------------------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'

export class GeminiOpenAIAdapter extends OpenAIChatAdapter {
  constructor(config: GeminiConfig) {
    super({
      apiServer: GEMINI_BASE,
      apiKey: config.apiKey,
      model: config.model,
      template: config.template,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
      completionsPath: '/v1beta/openai/chat/completions',
    })
  }
}

// ---------------------------------------------------------------------------
// GeminiNativeAdapter
// Uses @google/genai SDK models.generateContent / generateContentStream.
// Returns step-based ParsedTurn.
// ---------------------------------------------------------------------------

function toSDKContents(
  messages: Message[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }))
}

function extractSystem(messages: Message[]): string | undefined {
  return messages.find(m => m.role === 'system')?.content
}

function toThinkingLevel(level?: string): ThinkingLevel {
  switch (level) {
    case 'minimal': return ThinkingLevel.MINIMAL
    case 'low':     return ThinkingLevel.LOW
    case 'medium':  return ThinkingLevel.MEDIUM
    case 'high':    return ThinkingLevel.HIGH
    default:        return ThinkingLevel.MEDIUM
  }
}

export class GeminiNativeAdapter {
  readonly config: GeminiConfig
  private readonly client: GoogleGenAI

  constructor(config: GeminiConfig) {
    this.config = config
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  async status() {
    return { model: this.config.model }
  }

  async generate(messages: Message[]): Promise<ParsedTurn> {
    const cfg = this.config
    const response = await this.client.models.generateContent({
      model: cfg.model,
      contents: toSDKContents(messages) as any,
      config: {
        systemInstruction: extractSystem(messages),
        maxOutputTokens: cfg.maxTokens ?? 4096,
        temperature: cfg.temperature ?? 0.7,
        topP: cfg.topP ?? 0.95,
        ...(cfg.thinking || cfg.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: toThinkingLevel(cfg.thinkingLevel), includeThoughts: true } }
          : {}),
      },
    })

    const parts = (response.candidates?.[0]?.content?.parts ?? []) as Array<{
      text?: string
      thought?: boolean
    }>

    let think = ''
    let content = ''
    for (const part of parts) {
      if (part.thought) think += part.text ?? ''
      else content += part.text ?? ''
    }

    return makeTurn({ think: think || undefined, content: content || undefined })
  }

  async generateRaw(prompt: string): Promise<ParsedTurn> {
    return this.generate([{ role: 'user', content: prompt }])
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const cfg = this.config
    const stream = await this.client.models.generateContentStream({
      model: cfg.model,
      contents: toSDKContents(messages) as any,
      config: {
        systemInstruction: extractSystem(messages),
        maxOutputTokens: cfg.maxTokens ?? 4096,
        temperature: cfg.temperature ?? 0.7,
        topP: cfg.topP ?? 0.95,
        ...(cfg.thinking || cfg.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: toThinkingLevel(cfg.thinkingLevel), includeThoughts: true } }
          : {}),
      },
    })

    for await (const chunk of stream) {
      const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as Array<{
        text?: string
        thought?: boolean
      }>
      for (const part of parts) {
        if (!part.thought && part.text) yield part.text
      }
    }
  }

  async *streamRaw(prompt: string): AsyncGenerator<string> {
    yield* this.stream([{ role: 'user', content: prompt }])
  }
}

// ---------------------------------------------------------------------------
// GeminiInteractionsAdapter
// Uses the Interactions API (Beta) via @google/genai SDK.
// Stateful: stores previous_interaction_id across turns automatically.
// Returns step-based ParsedTurn.
// ---------------------------------------------------------------------------

export type GeminiInteractionsConfig = GeminiConfig & {
  /** Store interactions server-side (default: true). */
  store?: boolean
  thinkingSummaries?: 'auto' | 'none'
}

export class GeminiInteractionsAdapter {
  readonly config: GeminiInteractionsConfig
  private readonly client: GoogleGenAI
  private previousInteractionId?: string

  constructor(config: GeminiInteractionsConfig) {
    this.config = config
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  async status() {
    return { model: this.config.model }
  }

  /** Reset session — next call starts a fresh conversation. */
  resetSession(): void {
    this.previousInteractionId = undefined
  }

  async generate(messages: Message[]): Promise<ParsedTurn> {
    const interaction = await (this.client.interactions as any).create(
      this.buildParams(messages, false),
    ) as any

    this.previousInteractionId = interaction.id
    return parseInteractionOutputs(interaction.outputs ?? [], this.config.template)
  }

  async generateRaw(prompt: string): Promise<ParsedTurn> {
    return this.generate([{ role: 'user', content: prompt }])
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const stream = (await (this.client.interactions as any).create(
      this.buildParams(messages, true),
    )) as AsyncIterable<any>

    let interactionId: string | undefined

    for await (const chunk of stream) {
      switch (chunk.event_type) {
        case 'interaction.start':
          interactionId = chunk.interaction?.id
          break
        case 'content.delta':
          if (chunk.delta?.type === 'text' && chunk.delta.text) {
            yield chunk.delta.text as string
          }
          break
        case 'interaction.complete':
          interactionId = chunk.interaction?.id ?? interactionId
          break
      }
    }

    if (interactionId) this.previousInteractionId = interactionId
  }

  async *streamRaw(prompt: string): AsyncGenerator<string> {
    yield* this.stream([{ role: 'user', content: prompt }])
  }

  private buildParams(messages: Message[], streaming: boolean): Record<string, unknown> {
    const cfg = this.config
    const system = extractSystem(messages)
    const nonSystem = messages.filter(m => m.role !== 'system')

    // Stateful: send only the latest user message once a session is established.
    // Stateless (first turn): send full history as array.
    const input = this.previousInteractionId
      ? (nonSystem[nonSystem.length - 1]?.content ?? '')
      : nonSystem.map(m => ({ role: m.role === 'user' ? 'user' : 'model', content: m.content }))

    return {
      model: cfg.model,
      input,
      ...(this.previousInteractionId ? { previous_interaction_id: this.previousInteractionId } : {}),
      ...(system ? { system_instruction: system } : {}),
      store: cfg.store ?? true,
      stream: streaming,
      generation_config: {
        max_output_tokens: cfg.maxTokens ?? 4096,
        temperature: cfg.temperature ?? 0.7,
        top_p: cfg.topP ?? 0.95,
        ...(cfg.thinking || cfg.thinkingLevel
          ? {
              thinking_level: cfg.thinkingLevel ?? 'medium',
              thinking_summaries: cfg.thinkingSummaries ?? 'auto',
            }
          : {}),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Interactions output parser
// ---------------------------------------------------------------------------

function parseInteractionOutputs(
  outputs: Interactions.Content[],
  template: TextTemplate,
): ParsedTurn {
  let think = ''
  let content = ''

  for (const output of outputs) {
    if (output.type === 'thought') {
      const thought = output as Interactions.ThoughtContent
      think += thought.summary?.map((s: any) => s.text ?? '').join('') ?? ''
    } else if (output.type === 'text') {
      content += (output as Interactions.TextContent).text ?? ''
    }
  }

  // parse() handles template-based tool call extraction from content
  const parsed = parse(content, template)
  if (think) {
    parsed.steps.unshift({ kind: 'thought', text: think })
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Smoke test  (bun gemini.ts)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { Profiles } = await import('./template')
  const apiKey = process.env.GEMINI_API_KEY ?? ''
  const model  = process.env.MODEL ?? 'gemini-3.1-flash-lite-preview'

  consola.log('=== GeminiNativeAdapter ===')
  const native = new GeminiNativeAdapter({ apiKey, model, template: Profiles.qwen, maxTokens: 200 })
  consola.log(await native.generate([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hello in one sentence.' },
  ]))

  consola.log('\n=== GeminiNativeAdapter (thinking) ===')
  const thinking = new GeminiNativeAdapter({
    apiKey,
    model: 'gemini-2.5-flash-preview-04-17',
    template: Profiles.qwen,
    maxTokens: 500,
    thinking: true,
    thinkingLevel: 'low',
  })
  const r = await thinking.generate([{ role: 'user', content: 'What is 17 * 23?' }])
  consola.log('steps:', r.steps.map(s => ({ kind: s.kind, text: s.kind !== 'tool_call' ? s.text.slice(0, 80) : s.name })))

  consola.log('\n=== GeminiNativeAdapter stream ===')
  process.stdout.write('stream: ')
  for await (const token of native.stream([{ role: 'user', content: 'Count to 5.' }])) {
    process.stdout.write(token)
  }
  process.stdout.write('\n\n')

  consola.log('=== GeminiInteractionsAdapter ===')
  const interactions = new GeminiInteractionsAdapter({
    apiKey,
    model: 'gemini-3-flash-preview',
    template: Profiles.qwen,
    maxTokens: 200,
  })
  const r1 = await interactions.generate([{ role: 'user', content: 'My name is Malf.' }])
  consola.log('turn 1:', r1.steps)
  const r2 = await interactions.generate([{ role: 'user', content: 'What is my name?' }])
  consola.log('turn 2 (stateful):', r2.steps)

  consola.log('\n=== GeminiInteractionsAdapter stream ===')
  interactions.resetSession()
  process.stdout.write('stream: ')
  for await (const token of interactions.stream([{ role: 'user', content: 'Count to 3.' }])) {
    process.stdout.write(token)
  }
  process.stdout.write('\n')
}
