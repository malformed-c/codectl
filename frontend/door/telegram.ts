import { Bot, Context } from 'grammy'
import { hydrate } from "@grammyjs/hydrate"
import type { HydrateFlavor } from "@grammyjs/hydrate"
import { consola } from 'consola'
import { marked } from 'marked'
import { createRoom, touchRoom, RoomRegistry } from '../room'
import { HistoryStore } from '../history.ts'
import { Orchestrator, type OrchestratorConfig } from '../orchestrator'
import type { KoboldAdapter } from '../kobold'

// --- Types ---

export type TelegramDoorConfig = {
  token: string
  adapter: KoboldAdapter
  historyStore?: HistoryStore
  /** Extra orchestrator config per room (adapter is injected, do not set here) */
  orchestratorConfig?: Omit<OrchestratorConfig, 'adapter'>
  /** Max message length before splitting (Telegram text limit: 4096, with media: 1024) */
  maxMessageLength?: number
}

// --- Helpers ---

function splitMessage(text: string, maxLen = 4096): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt === -1) splitAt = maxLen

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function roomIdForChat(chatId: number): string {
  return `telegram-${chatId}`
}

/**
 * Convert markdown to Telegram-safe HTML.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>
 */
function escapeHtml(text: string | undefined | null): string {
  if (!text) return ''

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Walk inline token array (paragraph contents, list items, etc.)
function renderInline(tokens: any[]): string {
  return tokens.map(tok => {
    switch (tok.type) {
      case 'text': return escapeHtml(tok.text)
      case 'strong': return `<b>${renderInline(tok.tokens ?? [])}</b>`
      case 'em': return `<i>${renderInline(tok.tokens ?? [])}</i>`
      case 'del': return `<s>${renderInline(tok.tokens ?? [])}</s>`
      case 'codespan': return `<code>${escapeHtml(tok.text)}</code>`
      case 'link': return `<a href="${escapeHtml(tok.href ?? '')}">${renderInline(tok.tokens ?? [])}</a>`
      case 'image': return ''
      case 'html': return ''
      case 'br': return '\n'
      case 'escape': return escapeHtml(tok.text)
      default: return escapeHtml(tok.raw ?? '')
    }
  }).join('')
}

// Walk block token array
function renderBlock(tokens: any[]): string {
  return tokens.map(tok => {
    switch (tok.type) {
      case 'heading': return `<b>${renderInline(tok.tokens ?? [])}</b>\n`
      case 'paragraph': return `${renderInline(tok.tokens ?? [])}\n`
      case 'code': return `<pre>${escapeHtml(tok.text)}</pre>\n`
      case 'blockquote': return `<i>${renderBlock(tok.tokens ?? []).trim()}</i>\n`
      case 'hr': return '\n'
      case 'space': return ''
      case 'html': return ''
      case 'list': {
        return tok.items.map((item: any) => {
          // list_item.tokens may contain a nested text token with inline tokens inside
          const inner = item.tokens.flatMap((t: any) => t.tokens ?? [{ type: 'text', text: t.text, raw: t.raw }])

          return `- ${renderInline(inner).trim()}\n`
        }).join('') + '\n'
      }

      default: return escapeHtml(tok.raw ?? '')
    }
  }).join('')
}

/**
 * Best-effort markdown stripper for the plain-text fallback path.
 * Keeps the text readable without Telegram HTML parse_mode.
 */
function stripMarkdownToPlain(md: string): string {
  return md
    // Fenced code blocks - keep content, drop fences
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold / italic / strikethrough
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/___(.+?)___/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/_(.+?)_/gs, '$1')
    .replace(/~~(.+?)~~/gs, '$1')
    // Headings
    .replace(/^#{1,6}\s+/gm, '')
    // Block quote markers
    .replace(/^>\s?/gm, '')
    // List markers -> bullet
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^(\s*)\d+\.\s+/gm, '$1')
    // Literal two-char \n sequences the model sometimes emits
    .replace(/\\n/g, '\n')
    .trim()
}

function markdownToTelegramHTML(md: string | undefined | null): string {
  if (!md) return ''

  try {
    const tokens = marked.lexer(md)

    return renderBlock(tokens).trim()

  } catch (err) {

    consola.warn('markdownToTelegramHTML failed, sending plain text:', err)

    return stripMarkdownToPlain(md)
  }
}

// --- Telegram door ---

export class TelegramDoor {
  private readonly bot: Bot<HydrateFlavor<Context>>
  private readonly registry = new RoomRegistry()
  private readonly config: TelegramDoorConfig

  constructor(config: TelegramDoorConfig) {
    this.config = config
    this.bot = new Bot(config.token)
  }

  // --- Public API ---

  async start(): Promise<void> {
    consola.info('TelegramDoor starting...')

    // Middleware to allow only one user
    this.bot
      .use(async (ctx, next) => {
        consola.trace('TG: Filter middleware')

        if (!ctx.from || ctx.from.id !== Number(Bun.env.TELEGRAM_ALLOWED_USER!)) {
          consola.warn(`Blocked message from ${ctx.from?.id}`)

          return // stop processing this update
        }

        consola.trace('TG: Past filter middleware')

        await next() // allowed user passes through
      })
      .use(hydrate())

    this.setupHandlers()

    await this.bot.start({
      allowed_updates: ['message', 'callback_query']
    })
  }

  async stop(): Promise<void> {
    await this.bot.stop()

    consola.info('TelegramDoor stopped')
  }

  // --- Handlers ---

  private setupHandlers(): void {
    this.bot.command('start', async (ctx) => {
      consola.trace('TG: start command')

      // TODO
      await ctx.reply(
        'Hello! This is codectl system. Send a message to start chatting.\n' +
        'Use /new to start a fresh conversation.', {
        parse_mode: 'HTML'
      }
      )
    })

    this.bot.command('new', async (ctx) => {
      consola.trace('TG: new command')

      const roomId = roomIdForChat(ctx.chat.id)
      const existing = this.registry.get(roomId)

      if (this.config.historyStore) {
        if (existing) {
          await this.config.historyStore.archive(roomId, existing.meta, existing.orchestrator.getHistory() as any)

        } else {
          await this.config.historyStore.archive(roomId)
        }
      }

      if (existing) {
        existing.orchestrator.clearHistory()
        touchRoom(existing)
      }

      await ctx.reply('Started a new conversation.', {
        parse_mode: 'HTML'
      })
    })

    this.bot.command('mode', async (ctx) => {
      const room = this.getOrCreateRoom(ctx.chat.id)
      const mode = room.orchestrator.getMode()

      await ctx.reply(`Current mode: ${mode.kind}`, {
        parse_mode: 'HTML'
      })
    })

    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })
  }

  private async handleMessage(ctx: Context & { message: { text: string; chat: { id: number } } }): Promise<void> {
    const chatId = ctx.message.chat.id
    const text = ctx.message.text
    const room = this.getOrCreateRoom(chatId)

    consola.trace('Handle TG message')

    // Restore from checkpoint if orchestrator is fresh
    if (room.orchestrator.getHistory().length === 0) {
      const restored = await room.orchestrator.restoreCheckpoint()
      if (restored) {
        consola.debug(`[checkpoint] restored ${restored.history.length} rounds for room ${room.meta.id}`)
      }
    }

    // Show typing indicator
    // TODO Add timeout
    await ctx.replyWithChatAction('typing')

    try {
      for await (const event of room.orchestrator.chat(text)) {
        if (event.kind === 'turn') {
          // Send model's text content (final response after all tools done)
          const response = event.turn.content
          if (response) {
            const chunks = splitMessage(response, this.config.maxMessageLength)
            for (const chunk of chunks) {
              try {
                await ctx.reply(markdownToTelegramHTML(chunk), { parse_mode: 'HTML' })

              } catch {
                // HTML parse failed - fall back to stripped plain text
                await ctx.reply(stripMarkdownToPlain(chunk))
              }
            }
          }

        } else if (event.kind === 'call') {
          // Show call before it runs
          const args = JSON.stringify(event.call.arguments)
          try {
            await ctx.reply(`⏳ <code>${escapeHtml(event.call.name)}(${escapeHtml(args)})</code>`, { parse_mode: 'HTML' })

          } catch (err) {
            consola.warn('Failed to send call notification:', err)
          }

        } else if (event.kind === 'call_result') {
          // Show result immediately after execution
          const { call, result } = event
          const status = result.error
            ? `❌ <b>${escapeHtml(call.name)}</b>\n<code>${escapeHtml(result.error)}</code>`
            : `✅ <b>${escapeHtml(call.name)}</b>`

          const resultStr = result.error
            ? null
            : typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result, null, 2)

          const preview = resultStr && resultStr.length > 300
            ? resultStr.slice(0, 300) + '\n...'
            : resultStr

          const msg = preview
            ? `${status}\n<pre>${escapeHtml(preview)}</pre>`
            : status

          try {
            await ctx.reply(msg, { parse_mode: 'HTML' })

          } catch (err) {
            consola.warn('Failed to send tool result:', err)
          }
        }
      }

      touchRoom(room)

      // Checkpoints are saved automatically after each committed round in runLoop

    } catch (err) {
      consola.error('Error handling Telegram message:', err)

      await ctx.reply('Something went wrong. Please try again.', {
        parse_mode: 'HTML'
      })
    }
  }

  private getOrCreateRoom(chatId: number): ReturnType<RoomRegistry['getOrCreate']> {
    const roomId = roomIdForChat(chatId)

    return this.registry.getOrCreate(roomId, () =>
      createRoom(
        roomId,
        new Orchestrator({ ...this.config.orchestratorConfig, adapter: this.config.adapter }),
        `telegram:${chatId}`
      )
    )
  }
}
