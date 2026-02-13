import 'dotenv/config'
import { buildRenderedPrompt, resolvePromptMarkers, stringifyContent, type Message, type PromptMarkers, type ProviderBody } from './messages'
import { generate } from './kobold'

generate()
