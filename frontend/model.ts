import { buildRenderedPrompt, Message, ModelProfile, PromptMarkers } from './messages'

export class ModelSession {
  constructor(
    public profile: ModelProfile,
    public history: Message[] = []
  ) {}

  /**
   * Formats the current history into a single string for text completion APIs.
   */
  formatPrompt(): string {
    return buildRenderedPrompt(this.history, this.profile.markers).join('')
  }

  /**
   * Processes the model's raw response to extract reasoning and clean content.
   */
  parseAssistantResponse(rawResponse: string): { content: string; reasoning?: string } {
    let content = rawResponse
    let reasoning: string | undefined

    const { reasoningOpen, reasoningClose } = this.profile.markers
    if (reasoningOpen && reasoningClose) {
      const escapedOpen = this.escapeRegExp(reasoningOpen)
      const escapedClose = this.escapeRegExp(reasoningClose)
      const regex = new RegExp(`${escapedOpen}([\\s\\S]*?)${escapedClose}`, 'g')

      const matches = [...content.matchAll(regex)]
      if (matches.length > 0) {
        reasoning = matches.map(m => m[1]).join('\n').trim()
        content = content.replace(regex, '')
      }
    }

    // Strip other potential markers that might have leaked into content
    const allMarkers = [
      this.profile.markers.systemOpen, this.profile.markers.systemClose,
      this.profile.markers.userOpen, this.profile.markers.userClose,
      this.profile.markers.modelOpen, this.profile.markers.modelClose,
    ]

    for (const marker of allMarkers) {
      if (marker) {
        content = content.split(marker).join('')
      }
    }

    return {
      content: content.trim(),
      reasoning: reasoning
    }
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  addMessage(role: 'system' | 'user' | 'assistant', content: string, reasoning?: string): void {
    this.history.push({ role, content, reasoning })
  }

  addAssistantResponse(rawResponse: string): void {
    const { content, reasoning } = this.parseAssistantResponse(rawResponse)
    this.addMessage('assistant', content, reasoning)
  }
}
