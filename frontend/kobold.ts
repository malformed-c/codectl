import 'dotenv/config'
import { buildRenderedPrompt, resolvePromptMarkers, type Message } from './messages'

export type GenerateSettings = {
  api_server: string
  api_type: string
  prompt: string
  use_story: false
  use_memory: false
  use_authors_note: false
  use_world_info: false
  add_bos_token: true,
  streaming?: boolean
  num_ctx?: number
  num_predict?: number
  rep_pen?: number
  rep_pen_range?: number
  rep_pen_slope?: number
  temperature?: number
  tfs?: number
  top_a?: number
  top_k?: number
  top_p?: number
  min_p?: number
  typical?: number
  sampler_order?: number[]
  singleline?: boolean
  use_default_badwordsids?: boolean
  mirostat?: number
  mirostat_eta?: number
  mirostat_tau?: number
  grammar?: string
  sampler_seed?: number
  stop_sequence?: string[]
  dry_allowed_length: number
  dry_multiplier: number
  dry_base: number
  dry_sequence_breakers: string[]
  dry_penalty_last_n: number
}


function normalizeApiServer(apiServer: string): string {
  return apiServer.includes('localhost') ? apiServer.replace('localhost', '127.0.0.1') : apiServer
}

function buildPromptFromMessages(messages: Message[]): string {
  const markers = resolvePromptMarkers()

  return buildRenderedPrompt(messages, markers).join('')
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function buildGenerateBody(payload: Record<string, any>, requestPrompt: string): GenerateSettings {
  const baseSettings: GenerateSettings = {
    api_server: payload.api_server,
    api_type: payload.api_type ?? "koboldcpp",
    prompt: requestPrompt,
    add_bos_token: true,
    use_story: false,
    use_memory: false,
    use_authors_note: false,
    use_world_info: false,
    num_ctx: payload.num_ctx,
    num_predict: payload.num_predict,
    rep_pen: payload.rep_pen ?? 1.05,
    rep_pen_range: payload.rep_pen_range ?? 360,
    rep_pen_slope: payload.rep_pen_slope,
    temperature: payload.temperature ?? 0.70,
    tfs: payload.tfs,
    top_a: payload.top_a,
    top_k: payload.top_k,
    top_p: payload.top_p ?? 0.95,
    min_p: payload.min_p ?? 0.05,
    typical: payload.typical,
    sampler_order: payload.sampler_order ?? [6, 0, 1, 3, 4, 2, 5],
    singleline: payload.singleline,
    use_default_badwordsids: payload.use_default_badwordsids,
    mirostat: payload.mirostat,
    mirostat_eta: payload.mirostat_eta,
    mirostat_tau: payload.mirostat_tau,
    grammar: payload.grammar,
    sampler_seed: payload.sampler_seed ?? -1,
    stop_sequence: payload.stop_sequence ?? ["\nuser:", "</s>", "[INST]", "[SYSTEM_PROMPT]"],
    dry_allowed_length: payload.dry_allowed_length ?? 2,
    dry_base: payload.dry_base ?? 1.75,
    dry_multiplier: payload.dry_multiplier ?? 0.8,
    dry_penalty_last_n: payload.dry_penalty_last_n ?? 320,
    dry_sequence_breakers: ["\n", ":", '"', "*", "[THINK]", "[/THINK]"], // TODO Dynamically include reasoning tags from model
    // TODO add json schema support
    streaming: payload.streaming ?? false,
  }

  return baseSettings
}

export async function generate(payload: GenerateSettings): Promise<Response> {
  if (!payload?.api_server) return new Response(null, { status: 400 })

  payload.api_server = normalizeApiServer(payload.api_server)

  const args: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }

  const maxRetries = 3
  const retryDelayMs = 2500

  const url = payload.streaming
    ? `${payload.api_server}/extra/generate/stream`
    : `${payload.api_server}/v1/generate`

  for (let i = 0; i < maxRetries; i += 1) {
    try {
      const upstreamResponse = await fetch(url, args)

      if (payload.streaming) {
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: {
            'Content-Type': upstreamResponse.headers.get('content-type') ?? 'text/event-stream',
          },
        })
      }

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text()

        try {
          const errorJson = JSON.parse(errorText) as { detail?: { msg?: string } }
          return jsonResponse({ error: { message: errorJson?.detail?.msg || errorText } }, 400)

        } catch {
          return jsonResponse({ error: { message: errorText } }, 400)
        }
      }

      const data = await upstreamResponse.json()
      return jsonResponse(data)

    } catch (error) {
      const status = typeof error
        === 'object' && error && 'status'
        in error ? Number((error as { status?: unknown }).status) : 0

      if (status === 403 || status === 503) {
        await delay(retryDelayMs)

        continue
      }
    }
  }

  return jsonResponse({ error: true }, 500)
}

export async function status(payload: { api_server: string }): Promise<Response> {
  if (!payload?.api_server) return new Response(null, { status: 400 })

  const apiServer = normalizeApiServer(payload.api_server)

  const [koboldUnitedResponse, koboldExtraResponse, koboldModelResponse] = await Promise.all([
    fetch(`${apiServer}/v1/info/version`)
      .then(async (response) => (response.ok ? response.json() : { result: '0.0.0' }))
      .catch(() => ({ result: '0.0.0' })),
    fetch(`${apiServer}/extra/version`)
      .then(async (response) => (response.ok ? response.json() : { result: '0.0' }))
      .catch(() => ({ result: '0.0' })),
    fetch(`${apiServer}/v1/model`)
      .then(async (response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ])

  const result = {
    koboldUnitedVersion: (koboldUnitedResponse as { result?: string }).result ?? '0.0.0',
    koboldCppVersion: (koboldExtraResponse as { result?: string }).result ?? '0.0',
    model:
      !koboldModelResponse ||
        (koboldModelResponse as { result?: string }).result === 'ReadOnly'
        ? 'no_connection'
        : (koboldModelResponse as { result?: string }).result,
  }

  return jsonResponse(result)
}
