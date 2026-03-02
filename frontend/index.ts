import 'dotenv/config'
import { consola } from 'consola'
import { YAML } from 'bun'
import { KoboldAdapter } from './kobold'
import { Profiles, type Config } from './template'
import { HistoryStore } from './history'
import { TelegramDoor } from './door/telegram'
import { Orchestrator } from './orchestrator'
import { createRoom } from './room'

// --- Config ---

async function loadConfig(): Promise<Config> {
  const text = await Bun.file('config.yaml').text()

  return YAML.parse(text) as Config
}

// --- CLI door (inline - simple enough to not need its own file yet) ---

async function runCli(orchestrator: Orchestrator, historyStore: HistoryStore): Promise<void> {
  const roomId = 'cli-default'
  const room = createRoom(roomId, orchestrator, 'cli')

  // Restore from checkpoint if available
  const restored = await orchestrator.restoreCheckpoint()
  if (restored) {
    consola.info(`[checkpoint] restored ${restored.history.length} rounds`)
  }

  consola.info('codectl CLI ready. Type your message, Ctrl+C to exit.')

  process.stdout.write('> ')

  for await (const line of console) {
    const text = line.trim()

    if (!text) {
      process.stdout.write('> ')

      continue
    }

    // Slash commands
    if (text === '/new') {
      // resetSession() clears FSM + memory + mode and overwrites the checkpoint with
      // empty state, so the next restoreCheckpoint() call is a no-op.
      await orchestrator.resetSession()

      consola.info('Started new conversation')

      process.stdout.write('> ')

      continue
    }

    if (text === '/mode') {
      consola.info('Mode:', orchestrator.getMode())

      process.stdout.write('> ')

      continue
    }

    if (text === '/history') {
      const metas = await historyStore.list()
      if (metas.length === 0) {
        consola.info('No saved rooms')

      } else {
        for (const m of metas) consola.info(`  ${m.id} - ${m.label ?? ''} (${m.updatedAt})`)
      }

      process.stdout.write('> ')

      continue
    }

    if (text === '/help') {
      consola.log('Commands: /new /mode /history /help')

      process.stdout.write('> ')

      continue
    }

    try {
      for await (const event of orchestrator.chat(text)) {
        if (event.kind === 'turn') {
          if (event.turn.think) consola.debug('[think]', event.turn.think)

          if (event.turn.content) consola.log(event.turn.content)


          for (const te of event.toolsExecuted) {
            const args = JSON.stringify(te.call.arguments)
            const res = te.result.error ? `Error: ${te.result.error}` : 'success'

            consola.info(`  🛠️  ${te.call.name}(${args}) -> ${res}`)
          }
        }
      }

      // Checkpoints are saved automatically after each committed round in runLoop

    } catch (err) {
      consola.error('Error:', err)
    }

    process.stdout.write('> ')
  }
}

// --- Main ---

async function main(): Promise<void> {
  const config = await loadConfig()
  const historyStore = new HistoryStore(config.history_path)

  // One adapter, shared across all doors and rooms
  const adapter = new KoboldAdapter({
    apiServer: process.env.BASE_URL ?? config.api_server,
    template: Profiles.mistral, // TODO Profile is hardcoded for now; future: load from model YAML or config.yaml
  })

  // Check what doors to run based on env
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN
  const door = process.argv[2] ?? 'cli'

  if (door === 'telegram') {
    if (!telegramToken) {
      consola.error('TELEGRAM_BOT_TOKEN not set')

      process.exit(1)
    }

    const telegramDoor = new TelegramDoor({
      token: telegramToken,
      adapter,
      checkpointDir: config.checkpoint_path ?? './checkpoints',
      checkpointKeep: config.checkpoint_keep,
      orchestratorConfig: {
        toolFormat: (config.tool_format ?? 'json') as any,
        autonomousTurns: 16,
      },
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      consola.info('Shutting down...')

      await telegramDoor.stop()

      process.exit(0)
    })

    await telegramDoor.start()

  } else {
    // CLI door - one orchestrator, one room
    const orchestrator = new Orchestrator({
      adapter,
      toolFormat: (config.tool_format ?? 'json') as any,
      autonomousTurns: 16,
      checkpointDir: config.checkpoint_path ? `${config.checkpoint_path}/cli-default` : undefined,
      checkpointKeep: config.checkpoint_keep,
    })

    process.on('SIGINT', async () => {
      consola.info('Shutting down...')

      // Checkpoint is saved automatically after each committed round.
      // No extra save needed here.
      process.exit(0)
    })

    await runCli(orchestrator, historyStore)
  }
}

main().catch((err) => {
  consola.error('Fatal:', err)

  process.exit(1)
})
