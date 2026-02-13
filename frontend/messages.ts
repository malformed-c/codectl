export type Message = {
  role: string
  content: string
  name: string
}

export type ProviderBody = Record<string, unknown> & {
  messages?: Message[]
}

export type PromptMarkers = {
  systemOpen: string
  systemClose: string

  userOpen: string
  userClose: string

  modelOpen: string
  modelClose: string

  reasoningOpen: string
  reasoningClose: string

  stopSequence: string
}

export function resolvePromptMarkers(): PromptMarkers {
  return {
    systemOpen: process.env.PROMPT_SYSTEM_OPEN ?? '[SYSTEM_PROMPT]',
    systemClose: process.env.PROMPT_SYSTEM_CLOSE ?? '[/SYSTEM_PROMPT]\n',

    userOpen: process.env.PROMPT_USER_OPEN ?? '[INST]',
    userClose: process.env.PROMPT_USER_CLOSE ?? '[/INST]\n',

    modelOpen: process.env.PROMPT_MODEL_OPEN ?? '',
    modelClose: process.env.PROMPT_MODEL_CLOSE ?? '</s>\n',

    reasoningOpen: process.env.REASONING_OPEN ?? '[THINK]',
    reasoningClose: process.env.REASONING_CLOSE ?? '[/THINK]',

    stopSequence: process.env.PROMPT_STOP_SEQUENCE ?? '</s>',
  }
}

export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {

    return content
      .map((part) => {
        if (typeof part === 'string') return part

        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>

          if (obj.type === 'text' && typeof obj.text === 'string') return obj.text

          return JSON.stringify(obj, null, 2)
        }

        return String(part)

      })
      .join('\n')
  }

  if (content == null) return ''

  if (typeof content === 'object') return JSON.stringify(content, null, 2)

  return String(content)
}

export function buildRenderedPrompt(messages: Message[], markers: PromptMarkers): string {
  const rendered: string[] = []

  for (const message of messages) {
    const role = message.role ?? 'unknown'
    const text = stringifyContent(message.content)

    if (role === 'system') {
      rendered.push(`${markers.systemOpen}${text}\n${markers.systemClose}`)

      continue
    }

    if (role === 'user') {
      rendered.push(`${markers.userOpen}${text}${markers.userClose}`)

      continue
    }

    if (role === 'assistant') {
      rendered.push(`${markers.modelOpen}${text}${markers.modelClose}`)

      continue
    }

    const name = message.name ? ` name=${message.name}` : ''
    rendered.push(`[${role.toUpperCase()}${name}]\n${text}\n`)
  }

  return rendered.join('')
}
