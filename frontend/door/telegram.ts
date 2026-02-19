import { Bot, type Context } from 'grammy'
import { consola } from 'consola'
import { createRoom, touchRoom, RoomRegistry } from '../room'
import { HistoryStore } from '../history.ts'
import { Orchestrator } from '../orchestrator'

// --- Types ---

export type TelegramDoorConfig = {
  token: string
  historyStore?: HistoryStore
  /** Factory to create an orchestrator for a new room */
  createOrchestrator: () => Orchestrator
  /** Max message length before splitting (Telegram limit: 4096) */
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

// --- Telegram door ---

export class TelegramDoor {
  private readonly bot: Bot
  private readonly registry = new RoomRegistry()
  private readonly config: TelegramDoorConfig

  constructor(config: TelegramDoorConfig) {
    this.config = config
    this.bot = new Bot(config.token)
    this.setupHandlers()
  }

  // --- Public API ---

  async start(): Promise<void> {
    consola.info('TelegramDoor starting...')
    await this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
    consola.info('TelegramDoor stopped')
  }

  // --- Handlers ---

  private setupHandlers(): void {
    this.bot.command('start', async (ctx) => {
      // TODO
      await ctx.reply(
        "Hello! This is codectl system. Send a message to start chatting.\n" +
        'Use /new to start a fresh conversation.'
      )
    })

    this.bot.command('new', async (ctx) => {
      const roomId = roomIdForChat(ctx.chat.id)
      const existing = this.registry.get(roomId)

      if (existing) {
        // Save current history before clearing
        if (this.config.historyStore) {
          await this.config.historyStore.save(
            existing.meta,
            existing.orchestrator.getHistory()
          )
        }

        existing.orchestrator.clearHistory()
        touchRoom(existing)
      }

      await ctx.reply('Started a new conversation.')
    })

    this.bot.command('mode', async (ctx) => {
      const room = this.getOrCreateRoom(ctx.chat.id)
      const mode = room.orchestrator.getMode()

      await ctx.reply(`Current mode: ${mode.kind}`)
    })

    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })
  }

  private async handleMessage(ctx: Context & { message: { text: string; chat: { id: number } } }): Promise<void> {
    const chatId = ctx.message.chat.id
    const text = ctx.message.text
    const room = this.getOrCreateRoom(chatId)

    // Restore persisted history if orchestrator is fresh
    if (room.orchestrator.getHistory().length === 0 && this.config.historyStore) {
      const persisted = await this.config.historyStore.load(room.meta.id)

      if (persisted) {
        room.orchestrator.setHistory(persisted.history)
        consola.debug(`Restored history for room ${room.meta.id} (${persisted.history.length} messages)`)
      }
    }

    // Show typing indicator
    // Add timeout
    await ctx.replyWithChatAction('typing')

    try {
      const result = await room.orchestrator.chat(text)
      touchRoom(room)

      // Persist after each turn
      if (this.config.historyStore) {
        await this.config.historyStore.save(room.meta, room.orchestrator.getHistory())
      }

      const response = result.turn.content || '...'
      const chunks = splitMessage(response, this.config.maxMessageLength)

      for (const chunk of chunks) {
        await ctx.reply(chunk)
      }

    } catch (err) {
      consola.error('Error handling Telegram message:', err)
      await ctx.reply('Something went wrong. Please try again.')
    }
  }

  private getOrCreateRoom(chatId: number): ReturnType<RoomRegistry['getOrCreate']> {
    const roomId = roomIdForChat(chatId)

    return this.registry.getOrCreate(roomId, () =>
      createRoom(roomId, this.config.createOrchestrator(), `telegram:${chatId}`)
    )
  }
}

// --- Smoke test ---

if (import.meta.main) {
  const token = process.env.TELEGRAM_BOT_TOKEN

  if (!token) {
    consola.error('TELEGRAM_BOT_TOKEN not set')
    process.exit(1)
  }

  const { KoboldAdapter } = await import('../kobold')
  const { Profiles } = await import('../template')
  const { HistoryStore } = await import('../history.ts')

  const store = new HistoryStore('./history')

  const door = new TelegramDoor({
    token,
    historyStore: store,
    createOrchestrator: () => new Orchestrator({
      adapter: new KoboldAdapter({
        apiServer: process.env.BASE_URL ?? 'http://127.0.0.1:5001/api',
        template: Profiles.mistral,
        temperature: 0.7,
        numPredict: 512,
      }),
    }),
  })

  await door.start()
}
