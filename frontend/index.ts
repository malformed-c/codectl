import 'dotenv/config'
import { buildRenderedPrompt, resolvePromptMarkers, stringifyContent, type Message, type PromptMarkers, type ProviderBody } from './template'
import { generate } from './kobold'

generate()
