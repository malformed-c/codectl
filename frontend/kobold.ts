import { render, renderFim, parse } from './template'
import type { Message, TextTemplate, FimRequest, ParsedTurn } from './template'

// --- Types ---

export type KoboldConfig = {
  apiServer: string
  template: TextTemplate

  // Sampling
  numCtx?: number
  numPredict?: number
  temperature?: number
  topP?: number
  topK?: number
  topA?: number
  minP?: number
  tfs?: number
  typical?: number
  repPen?: number
  repPenRange?: number
  repPenSlope?: number
  mirostat?: number
  mirostatEta?: number
  mirostatTau?: number
  samplerOrder?: number[]
  samplerSeed?: number

  // DRY
  dryMultiplier?: number
  dryBase?: number
  dryAllowedLength?: number
  dryPenaltyLastN?: number
  drySequenceBreakers?: string[]

  // Misc
  grammar?: string
  stopSequence?: string[]
  streaming?: boolean
}

export type KoboldStatus = {
  koboldUnitedVersion: string
  koboldCppVersion: string
  model: string
}

export class KoboldError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'KoboldError'
  }
}

// --- Helpers ---

function normalizeServer(server: string): string {
  return server.includes('localhost')
    ? server.replace('localhost', '127.0.0.1')
    : server
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Adapter ---

export class KoboldAdapter {
  private readonly server: string
  readonly config: KoboldConfig

  constructor(config: KoboldConfig) {
    this.config = config
    this.server = normalizeServer(config.apiServer)
  }

  // --- Public API ---

  async generate(messages: Message[]): Promise<ParsedTurn> {
    const prompt = render(messages, this.config.template)

    const raw = await this.complete(prompt)

    return parse(raw, this.config.template)
  }

  async generateFim(req: FimRequest): Promise<string> {
    const prompt = renderFim(req, this.config.template)

    if (!prompt) {
      throw new KoboldError('FIM is not supported by the current template profile')
    }

    const raw = await this.complete(prompt)
    // FIM response should be raw content - no conversation parsing needed
    return raw.trim()
  }

  async status(): Promise<KoboldStatus> {
    const [united, extra, model] = await Promise.all([
      fetch(`${this.server}/v1/info/version`)
        .then((r) => (r.ok ? r.json() : { result: '0.0.0' }))
        .catch(() => ({ result: '0.0.0' })),
      fetch(`${this.server}/extra/version`)
        .then((r) => (r.ok ? r.json() : { result: '0.0' }))
        .catch(() => ({ result: '0.0' })),
      fetch(`${this.server}/v1/model`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])

    return {
      koboldUnitedVersion: (united as { result?: string }).result ?? '0.0.0',
      koboldCppVersion: (extra as { result?: string }).result ?? '0.0',
      model:
        !model || (model as { result?: string }).result === 'ReadOnly'
          ? 'no_connection'
          : (model as { result?: string }).result ?? 'unknown',
    }
  }

  // --- Streaming ---

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const prompt = render(messages, this.config.template)
    const body = this.buildPayload(prompt, true)

    const response = await fetch(`${this.server}/extra/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok || !response.body) {
      throw new KoboldError(`Stream failed: ${response.status}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      // KoboldCPP SSE: lines starting with 'data: '
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue

        try {
          const data = JSON.parse(line.slice(6)) as { token?: string }

          if (data.token) yield data.token

        } catch {
          // Malformed SSE line - skip
        }
      }

    }
  }

  // --- Internals ---

  private async complete(prompt: string, retries = 3): Promise<string> {
    const body = this.buildPayload(prompt, false)
    const url = `${this.server}/v1/generate`

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const text = await response.text()
          let message = text

          try {
            const json = JSON.parse(text) as { detail?: { msg?: string } }
            message = json?.detail?.msg ?? text
          } catch { /* use raw text */ }

          throw new KoboldError(message, response.status)
        }

        const data = await response.json() as { results?: Array<{ text: string }> }
        return data.results?.[0]?.text ?? ''

      } catch (err) {
        if (err instanceof KoboldError) {
          // Don't retry client errors
          if (err.status && err.status < 500) throw err
        }

        if (i < retries - 1) {
          await delay(2500)

          continue
        }

        throw err
      }
    }

    throw new KoboldError('Max retries exceeded')
  }

  private buildPayload(prompt: string, streaming: boolean): Record<string, unknown> {
    const cfg = this.config
    const eos = cfg.template.eos

    // Merge template EOS into stop sequences
    const stopSequence = [
      ...(cfg.stopSequence ?? []),
      ...(eos ? [eos] : []),
    ]

    // DRY sequence breakers - include think + tool tokens
    const dryBreakers = cfg.drySequenceBreakers ?? ['\n', ':', "'", '*']

    const addBreaker = (token: string | undefined) => {
      if (token && !dryBreakers.includes(token)) dryBreakers.push(token.trim())
    }

    const { think, toolCall, toolResult, availableTools } = cfg.template

    if (think) { addBreaker(think[0]); addBreaker(think[1]) }

    // toolCall / toolResult may be TemplatePair or rich - extract wrap tokens
    const toolCallWrap = Array.isArray(toolCall) ? toolCall : toolCall?.wrap
    const toolResultWrap = Array.isArray(toolResult) ? toolResult : toolResult?.wrap

    if (toolCallWrap) { addBreaker(toolCallWrap[0]); addBreaker(toolCallWrap[1]) }
    if (toolResultWrap) { addBreaker(toolResultWrap[0]); addBreaker(toolResultWrap[1]) }
    if (availableTools) { addBreaker(availableTools[0]); addBreaker(availableTools[1]) }

    // Mistral rich tokens
    if (toolCall && !Array.isArray(toolCall) && toolCall.rich) {
      addBreaker(toolCall.rich.callId)
      addBreaker(toolCall.rich.args)
    }
    if (toolResult && !Array.isArray(toolResult) && toolResult.rich) {
      addBreaker(toolResult.rich.callId)
      addBreaker(toolResult.rich.content)
    }

    return {
      prompt,
      add_bos_token: true,
      use_story: false,
      use_memory: false,
      use_authors_note: false,
      use_world_info: false,
      streaming,
      num_ctx: cfg.numCtx,
      num_predict: cfg.numPredict ?? 512,
      temperature: cfg.temperature ?? 0.7,
      top_p: cfg.topP ?? 0.95,
      top_k: cfg.topK,
      top_a: cfg.topA,
      min_p: cfg.minP ?? 0.05,
      tfs: cfg.tfs,
      typical: cfg.typical,
      rep_pen: cfg.repPen ?? 1.05,
      rep_pen_range: cfg.repPenRange ?? 360,
      rep_pen_slope: cfg.repPenSlope,
      mirostat: cfg.mirostat,
      mirostat_eta: cfg.mirostatEta,
      mirostat_tau: cfg.mirostatTau,
      sampler_order: cfg.samplerOrder ?? [6, 0, 1, 3, 4, 2, 5],
      sampler_seed: cfg.samplerSeed ?? -1,
      grammar: cfg.grammar,
      stop_sequence: stopSequence,
      dry_multiplier: cfg.dryMultiplier ?? 0.8,
      dry_base: cfg.dryBase ?? 1.75,
      dry_allowed_length: cfg.dryAllowedLength ?? 2,
      dry_penalty_last_n: cfg.dryPenaltyLastN ?? 320,
      dry_sequence_breakers: dryBreakers,
    }
  }
}

// --- Smoke test ---

if (import.meta.main) {
  const { Profiles } = await import('./template')

  const kobold = new KoboldAdapter({
    apiServer: Bun.env.BASE_URL!,
    template: Profiles.mistral,
    temperature: 0.7,
    numPredict: 200,
  })

  console.log('=== status ===')
  console.log(await kobold.status())

  console.log('\n=== generate ===')
  const result = await kobold.generate([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hello in one sentence.' },
  ])
  console.log(result)
}
