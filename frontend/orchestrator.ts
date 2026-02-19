import { match } from 'ts-pattern'
import type { KoboldAdapter } from './kobold'
import type { Message, ParsedTurn, TextTemplate } from './template'
import {
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolFormat,
  parseToolCalls,
  renderTools,
  renderToolResult,
  ModeTool,
} from './tool'

// --- Types ---

export type Mode =
  | { kind: 'chat' }
  | { kind: 'code/plan'; gitRoot: string }
  | { kind: 'code/gen'; gitRoot: string; streamId: string }

export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<ToolResult>

export type OrchestratorConfig = {
  adapter: KoboldAdapter
  systemPrompt?: string
  tools?: ToolDefinition[]
  toolFormat?: ToolFormat
  /** Max tool call rounds per user message before breaking the loop */
  maxToolRounds?: number
}

export type TurnResult = {
  turn: ParsedTurn
  mode: Mode
  toolsExecuted: Array<{ call: ToolCall; result: ToolResult }>
}

// --- Git detection ---

async function findGitRoot(dir: string): Promise<string | null> {
  const { dirname, join } = await import('node:path')
  let current = dir

  while (true) {
    if (await Bun.file(join(current, '.git')).exists()) return current

    const parent = dirname(current)

    if (parent === current) return null
    current = parent
  }
}

// --- Orchestrator ---

export class Orchestrator {
  private readonly adapter: KoboldAdapter
  private readonly profile: TextTemplate
  private readonly config: OrchestratorConfig
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly tools: ToolDefinition[] = []

  private history: Message[] = []
  private mode: Mode = { kind: 'chat' }
  private abortController: AbortController | null = null

  constructor(config: OrchestratorConfig) {
    this.adapter = config.adapter
    this.config = config
    this.profile = config.adapter.config.template

    // Register built-in mode tool
    this.registerTool(ModeTool, async (args) => {
      const targetMode = args.mode as string

      const result = await this.handleModeSwitch(targetMode)
      return result
    })

    // Register user-provided tools
    for (const tool of config.tools ?? []) {
      this.tools.push(tool)
    }
  }

  // --- Public API ---

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.push(def)
    this.handlers.set(def.name, handler)
  }

  getMode(): Mode {
    return this.mode
  }

  getHistory(): Message[] {
    return [...this.history]
  }

  clearHistory(): void {
    this.history = []
    this.rebuildSystemMessage()
  }

  abort(): void {
    this.abortController?.abort()
  }

  async chat(userMessage: string): Promise<TurnResult> {
    this.abortController = new AbortController()

    // Ensure system message is first
    if (this.history.length === 0) {
      this.rebuildSystemMessage()
    }

    this.history.push({ role: 'user', content: userMessage })

    const toolsExecuted: TurnResult['toolsExecuted'] = []
    const maxRounds = this.config.maxToolRounds ?? 8
    let finalTurn: ParsedTurn = { content: '' }

    for (let round = 0; round < maxRounds; round++) {
      const messages = this.buildMessages()

      const turn = await this.adapter.generate(messages)
      finalTurn = turn

      // No tool calls - done
      if (!turn.toolCalls?.length) {
        this.history.push({ role: 'assistant', content: turn.content })

        break
      }

      // Push the assistant turn with tool calls into history
      this.history.push({ role: 'tool_call', content: turn.toolCalls.join('\n') })

      // Execute each tool call
      for (const rawCall of turn.toolCalls) {
        let calls: ToolCall[]

        try {
          calls = parseToolCalls(rawCall)

        } catch (err) {
          const result: ToolResult = { result: null, error: `Failed to parse tool call: ${err}` }
          this.history.push({ role: 'tool_result', content: renderToolResult(result) })

          continue
        }

        for (const call of calls) {
          const result = await this.executeToolCall(call)

          toolsExecuted.push({ call, result })
          this.history.push({ role: 'tool_result', content: renderToolResult(result) })
        }
      }
    }

    return { turn: finalTurn, mode: this.mode, toolsExecuted }
  }

  // --- Internals ---

  private buildMessages(): Message[] {
    const allTools = this.tools

    if (allTools.length === 0) return this.history

    // Inject available tools into system turn
    const toolsContent = renderTools(allTools, this.config.toolFormat ?? 'json')
    const [systemMsg, ...rest] = this.history

    const enrichedSystem: Message = {
      role: 'system',
      // TODO refactor
      content: `${systemMsg?.content ?? ''}\n\n${this.profile.availableTools![0]}${toolsContent}${this.profile.availableTools![1]}`,
    }

    return [enrichedSystem, ...rest]
  }

  private rebuildSystemMessage(): void {
    const base = this.config.systemPrompt ?? this.defaultSystemPrompt()

    const modeContext = match(this.mode)
      .with({ kind: 'chat' }, () => '')
      .with({ kind: 'code/plan' }, ({ gitRoot }) =>
        `\n\nYou are in code/plan mode. Git root: ${gitRoot}`
      )
      .with({ kind: 'code/gen' }, ({ gitRoot, streamId }) =>
        `\n\nYou are in code/gen mode. Git root: ${gitRoot}. Resolving stream: ${streamId}`
      )
      .exhaustive()

    // Replace or insert system message
    const sysIdx = this.history.findIndex((m) => m.role === 'system')
    const sysMsg: Message = { role: 'system', content: base + modeContext }

    if (sysIdx === -1) {
      this.history.unshift(sysMsg)

    } else {
      this.history[sysIdx] = sysMsg
    }
  }

  private async executeToolCall(call: ToolCall): Promise<ToolResult> {
    const handler = this.handlers.get(call.name)

    if (!handler) {
      return { result: null, error: `Unknown tool: ${call.name}` }
    }

    try {
      return await handler(call.arguments)

    } catch (err) {
      return { result: null, error: String(err) }
    }
  }

  private async handleModeSwitch(targetMode: string): Promise<ToolResult> {
    const prev = this.mode

    if (targetMode === 'chat') {
      this.mode = { kind: 'chat' }
      this.rebuildSystemMessage()

      return { result: { switched: 'chat' } }
    }

    if (targetMode === 'code/plan' || targetMode === 'code/gen') {
      const gitRoot = await findGitRoot(process.cwd())
      let errMsg = undefined

      if (!gitRoot) {
        errMsg = 'No git repository found in current directory or any parent'
      }

      this.rebuildSystemMessage()
      return { result: { switched: targetMode, result: gitRoot, error: errMsg } }
    }

    return { result: null, error: `Unknown mode: ${targetMode}` }
  }

  private defaultSystemPrompt(): string {
    return `You're in codectl system. You can have general conversations and help with code tasks.

In code/plan mode you can:
- Access to codeq additional information
- Explore the repository structure
- Generate a CodePlan describing code modifications

Tools are your hands, you must acknowledge tool results.
Use token tool calls like this: [TOOL_CALLS]...[CALL_ID]...[ARGS]...`
  }
}

// --- Smoke test ---

if (import.meta.main) {
  const { KoboldAdapter } = await import('./kobold')
  const { Profiles } = await import('./template')

  const adapter = new KoboldAdapter({
    apiServer: process.env.BASE_URL ?? 'http://127.0.0.1:5001/api',
    template: Profiles.mistral,
    temperature: 0.7,
    numPredict: 300,
  })

  const orchestrator = new Orchestrator({
    adapter,
    toolFormat: 'python',
  })

  console.log('=== chat (no tools) ===')
  const r1 = await orchestrator.chat('Hi. Say hello in one sentence.')
  console.log(r1.turn.content)
  console.log('mode:', r1.mode)

  console.log('\n=== tools ===')
  const r2 = await orchestrator.chat('Can you list available tools.')
  console.log(r2.turn.content)
  console.log('mode:', r2.mode)

  console.log('\n=== mode switch ===')
  const r3 = await orchestrator.chat('Can we test tools? Can you switch to code/plan mode using tool calls.')
  console.log(r3.turn.content)
  console.log('mode:', r3.mode)
  console.log('tools executed:', r3.toolsExecuted)
}
