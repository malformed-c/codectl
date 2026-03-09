import consola from 'consola'
import { GoogleGenAI, ThinkingLevel, type Interactions } from '@google/genai'
import { parse, makeTurn } from './template'
import type { Message, TextTemplate, ParsedTurn } from './template'
import type { ToolDefinition } from './tool'
import { OpenAIChatAdapter } from './openai'
import { withRetry } from './utils/retry'

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
// ---------------------------------------------------------------------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'

export class GeminiOpenAIAdapter extends OpenAIChatAdapter {
  readonly supportsNativeTools = false

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
// ---------------------------------------------------------------------------

export class GeminiNativeAdapter {
  readonly supportsNativeTools = true
  readonly config: GeminiConfig
  private readonly client: GoogleGenAI

  constructor(config: GeminiConfig) {
    this.config = config
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  async status() { return { model: this.config.model } }

  async generate(messages: Message[], tools?: ToolDefinition[]): Promise<ParsedTurn> {
    const cfg = this.config
    const response = await withRetry(() =>
      this.client.models.generateContent({
        model: cfg.model,
        contents: messagesToSDKContents(messages),
        config: {
          systemInstruction: extractSystem(messages),
          maxOutputTokens: cfg.maxTokens ?? 4096,
          temperature: cfg.temperature ?? 0.7,
          topP: cfg.topP ?? 0.95,
          ...(tools?.length ? { tools: [{ functionDeclarations: toFunctionDeclarations(tools) }] } : {}),
          ...(cfg.thinking || cfg.thinkingLevel
            ? { thinkingConfig: { thinkingLevel: toThinkingLevel(cfg.thinkingLevel), includeThoughts: true } }
            : {}),
        },
      })
    )
    const candidate = response.candidates?.[0]
    consola.debug('[gemini] finishReason:', (candidate as any)?.finishReason, 'parts:', candidate?.content?.parts?.length)
    return parseSDKResponse(candidate?.content?.parts ?? [])
  }

  async generateRaw(prompt: string): Promise<ParsedTurn> {
    return this.generate([{ role: 'user', content: prompt }])
  }

  async *stream(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    const cfg = this.config
    const stream = await this.client.models.generateContentStream({
      model: cfg.model,
      contents: messagesToSDKContents(messages),
      config: {
        systemInstruction: extractSystem(messages),
        maxOutputTokens: cfg.maxTokens ?? 4096,
        temperature: cfg.temperature ?? 0.7,
        topP: cfg.topP ?? 0.95,
        ...(tools?.length ? { tools: [{ functionDeclarations: toFunctionDeclarations(tools) }] } : {}),
        ...(cfg.thinking || cfg.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: toThinkingLevel(cfg.thinkingLevel), includeThoughts: true } }
          : {}),
      },
    })
    for await (const chunk of stream) {
      const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as SDKPart[]
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
// ---------------------------------------------------------------------------

export type GeminiInteractionsConfig = GeminiConfig & {
  /** Store interactions server-side (default: true). Stateless when false. */
  store?: boolean
  thinkingSummaries?: 'auto' | 'none'
}

export class GeminiInteractionsAdapter {
  readonly supportsNativeTools = true
  readonly config: GeminiInteractionsConfig
  private readonly client: GoogleGenAI
  private previousInteractionId?: string

  constructor(config: GeminiInteractionsConfig) {
    this.config = config
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  async status() { return { model: this.config.model } }

  resetSession(): void { this.previousInteractionId = undefined }

  async generate(messages: Message[], tools?: ToolDefinition[]): Promise<ParsedTurn> {
    const interaction = await withRetry(() =>
      (this.client.interactions as any).create(
        this.buildParams(messages, false, tools),
      ) as Promise<any>,
      { label: 'gemini interactions generate' },
    )

    if (this.config.store !== false) {
      this.previousInteractionId = interaction.id
    }

    return parseInteractionOutputs(interaction.outputs ?? [], this.config.template)
  }

  async generateRaw(prompt: string): Promise<ParsedTurn> {
    return this.generate([{ role: 'user', content: prompt }])
  }

  async *stream(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    const stream = (await (this.client.interactions as any).create(
      this.buildParams(messages, true, tools),
    )) as AsyncIterable<any>

    let interactionId: string | undefined
    for await (const chunk of stream) {
      switch (chunk.event_type) {
        case 'interaction.start':   interactionId = chunk.interaction?.id; break
        case 'content.delta':
          if (chunk.delta?.type === 'text' && chunk.delta.text) yield chunk.delta.text as string
          break
        case 'interaction.complete': interactionId = chunk.interaction?.id ?? interactionId; break
      }
    }
    if (this.config.store !== false && interactionId) {
      this.previousInteractionId = interactionId
    }
  }

  async *streamRaw(prompt: string): AsyncGenerator<string> {
    yield* this.stream([{ role: 'user', content: prompt }])
  }

  private buildParams(messages: Message[], streaming: boolean, tools?: ToolDefinition[]): Record<string, unknown> {
    const cfg = this.config
    const system = extractSystem(messages)
    const nonSystem = messages.filter(m => m.role !== 'system')

    // Stateful (store=true, default): send only latest message once session is established.
    // Stateless (store=false): send full history every turn — no server-side memory used.
    const stateful = cfg.store !== false && !!this.previousInteractionId
    const input = stateful
      ? (nonSystem[nonSystem.length - 1]?.content ?? '')
      : nonSystem.map(m => ({ role: m.role === 'user' ? 'user' : 'model', content: m.content }))

    return {
      model: cfg.model,
      input,
      ...(stateful ? { previous_interaction_id: this.previousInteractionId } : {}),
      ...(system ? { system_instruction: system } : {}),
      store: cfg.store ?? true,
      stream: streaming,
      ...(tools?.length ? { tools: [{ function_declarations: toFunctionDeclarations(tools) }] } : {}),
      generation_config: {
        max_output_tokens: cfg.maxTokens ?? 4096,
        temperature: cfg.temperature ?? 0.7,
        top_p: cfg.topP ?? 0.95,
        ...(cfg.thinking || cfg.thinkingLevel
          ? { thinking_level: cfg.thinkingLevel ?? 'medium', thinking_summaries: cfg.thinkingSummaries ?? 'auto' }
          : {}),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// SDK helpers
// ---------------------------------------------------------------------------

type SDKPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: unknown }
}

type SDKContent = { role: string; parts: SDKPart[] }

function toThinkingLevel(level?: string): ThinkingLevel {
  switch (level) {
    case 'minimal': return ThinkingLevel.MINIMAL
    case 'low':     return ThinkingLevel.LOW
    case 'medium':  return ThinkingLevel.MEDIUM
    case 'high':    return ThinkingLevel.HIGH
    default:        return ThinkingLevel.MEDIUM
  }
}

function toFunctionDeclarations(tools: ToolDefinition[]): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: {
      ...t.parameters,
      properties: Object.fromEntries(
        Object.entries(t.parameters.properties ?? {}).map(
          ([k, { aliases: _aliases, ...prop }]: [string, any]) => [k, prop]
        )
      ),
    },
  }))
}

export function messagesToSDKContents(messages: Message[]): SDKContent[] {
  const out: SDKContent[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      // The first system message is already passed as systemInstruction — skip it.
      // Subsequent system messages (corrections, nudges) need to reach the model.
      // Gemini requires strict user/model alternation so we can't inject a bare
      // user turn — instead append to the last user/tool_result part if possible.
      if (out.length === 0) continue
      const last = out[out.length - 1]
      if (last && (last.role === 'user')) {
        last.parts = [...last.parts, { text: `\n[System: ${m.content}]` }]
      }
      continue
    }

    if (m.role === 'tool_result' && m.results?.length) {
      // Tool result message — must be checked BEFORE calls check since tool_result
      // messages also carry calls[] for name recovery.
      const callNames = m.calls?.map(c => c.tool) ?? []
      const MAX_RESULT = 8000
      out.push({
        role: 'user',
        parts: m.results.map((r, i) => {
          const response = r.error
            ? { error: r.error }
            : typeof r.value === 'string'
              ? { output: r.value.length > MAX_RESULT ? r.value.slice(0, MAX_RESULT) + '\n...(truncated)' : r.value }
              : { output: JSON.stringify(r.value) }  // stringify objects — Gemini proto rejects nested arrays
          return { functionResponse: { name: callNames[i] ?? `tool_${i}`, response } }
        }),
      })
    } else if (m.calls?.length) {
      // Model message with function calls.
      // First call carries thoughtSignature (Gemini 3 requirement) — strip it from args.
      out.push({
        role: 'model',
        parts: m.calls.map((c, i) => {
          const { tool, callId, thoughtSignature, ...args } = c
          return {
            functionCall: { name: tool, args: args as Record<string, unknown> },
            ...(i === 0 && thoughtSignature ? { thoughtSignature } : {}),
          }
        }),
      })
    } else {
      out.push({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      })
    }
  }
  return out
}

function extractSystem(messages: Message[]): string | undefined {
  return messages.find(m => m.role === 'system')?.content
}

/** Parse SDK response parts into a step-based ParsedTurn. */
function parseSDKResponse(parts: SDKPart[]): ParsedTurn {
  consola.debug('[gemini] response parts:', JSON.stringify(parts.map(p => ({
    thought: p.thought,
    hasText: !!p.text,
    textLen: p.text?.length,
    hasSig: !!p.thoughtSignature,
    hasFn: !!p.functionCall,
    fnName: p.functionCall?.name,
  }))))
  let think = ''
  let content = ''
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown>; thoughtSignature?: string }> = []

  // Gemini 3: thoughtSignature is on the first functionCall part (or last text part).
  // It must be stored and replayed exactly when sending history back.
  let pendingSignature: string | undefined

  for (const part of parts) {
    if (part.thought) {
      think += part.text ?? ''
    } else if (part.functionCall) {
      const signature = part.thoughtSignature ?? pendingSignature
      toolCalls.push({
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
        ...(signature ? { thoughtSignature: signature } : {}),
      })
      pendingSignature = undefined
    } else if (part.text) {
      if (part.thoughtSignature) pendingSignature = part.thoughtSignature
      content += part.text
    }
  }

  return makeTurn({
    think: think || undefined,
    content: content || undefined,
    toolCalls,
  })
}

function parseInteractionOutputs(outputs: Interactions.Content[], template: TextTemplate): ParsedTurn {
  let think = ''
  let content = ''
  for (const output of outputs) {
    if (output.type === 'thought') {
      think += (output as Interactions.ThoughtContent).summary?.map((s: any) => s.text ?? '').join('') ?? ''
    } else if (output.type === 'text') {
      content += (output as Interactions.TextContent).text ?? ''
    }
  }
  const parsed = parse(content, template)
  if (think) parsed.steps.unshift({ kind: 'thought', text: think })
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
  const thinking = new GeminiNativeAdapter({ apiKey, model: 'gemini-2.5-flash-preview-04-17', template: Profiles.qwen, maxTokens: 500, thinking: true, thinkingLevel: 'low' })
  const r = await thinking.generate([{ role: 'user', content: 'What is 17 * 23?' }])
  consola.log('steps:', r.steps.map(s => ({ kind: s.kind, text: s.kind !== 'tool_call' ? s.text.slice(0, 80) : s.name })))

  consola.log('\n=== GeminiNativeAdapter stream ===')
  process.stdout.write('stream: ')
  for await (const token of native.stream([{ role: 'user', content: 'Count to 5.' }])) process.stdout.write(token)
  process.stdout.write('\n\n')

  consola.log('=== GeminiInteractionsAdapter (store=true, stateful) ===')
  const interactions = new GeminiInteractionsAdapter({ apiKey, model: 'gemini-3-flash-preview', template: Profiles.qwen, maxTokens: 200 })
  consola.log('turn 1:', (await interactions.generate([{ role: 'user', content: 'My name is Malf.' }])).steps)
  consola.log('turn 2 (stateful):', (await interactions.generate([{ role: 'user', content: 'What is my name?' }])).steps)

  consola.log('\n=== GeminiInteractionsAdapter (store=false, stateless) ===')
  const stateless = new GeminiInteractionsAdapter({ apiKey, model: 'gemini-3-flash-preview', template: Profiles.qwen, maxTokens: 200, store: false })
  const s1 = await stateless.generate([{ role: 'user', content: 'My name is Malf.' }])
  const s1text = s1.steps.find(s => s.kind === 'text')?.text ?? ''
  const s2 = await stateless.generate([
    { role: 'user', content: 'My name is Malf.' },
    { role: 'assistant', content: s1text },
    { role: 'user', content: 'What is my name?' },
  ])
  consola.log('turn 1:', s1.steps)
  consola.log('turn 2 (stateless, full history):', s2.steps)

  consola.log('\n=== GeminiInteractionsAdapter stream ===')
  interactions.resetSession()
  process.stdout.write('stream: ')
  for await (const token of interactions.stream([{ role: 'user', content: 'Count to 3.' }])) process.stdout.write(token)
  process.stdout.write('\n')
}
