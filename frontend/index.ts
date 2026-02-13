import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import 'dotenv/config'
import { buildRenderedPrompt, resolvePromptMarkers, type ProviderBody } from './messages'

function logPromptBeforeProviderSend(body: ProviderBody): Record<string, unknown> {
  const output = buildRenderedPrompt(body.messages?? [], resolvePromptMarkers())

  console.log('[prompt preview]\n')
  console.log(output)
  console.log('')

  // TODO format body

  return body
}

const provider = createOpenAICompatible({
  name: 'local',
  baseURL: process.env.BASE_URL!,
  supportsStructuredOutputs: true,
  transformRequestBody: (body) => {
    logPromptBeforeProviderSend(body as Record<string, unknown>)
    return body
  },
})

const model = provider('model')

const { text } = await generateText({
  model,
  prompt: "Why's sky is blue?",
})

console.log(text)
