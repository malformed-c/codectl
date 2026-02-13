import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import 'dotenv/config'

const provider = createOpenAICompatible({
  name: 'local',
  baseURL: process.env.BASE_URL!,
  supportsStructuredOutputs: true,
  transformRequestBody: undefined, // TODO
})
