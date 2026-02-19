import { consola, createConsola } from "consola"
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
  /** Max autonomous turns before giving up */
  autonomousTurns?: number
  /** Current nesting depth (set by subagent tool) */
  depth?: number
  /** Max subagent nesting depth */
  maxDepth?: number
}

export type TurnResult = {
  turn: ParsedTurn
  toolsExecuted: Array<{ call: ToolCall; result: ToolResult }>
}

// --- Built-in: continue tool ---

export const ContinueTool: ToolDefinition = {
  name: 'continue',
  description:
    'Signal that you need more turns to complete the task. ' +
    'Use when you have more work to do after this response.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why you need to continue.',
      },
    },
    required: [],
  },
  returns: {
    type: 'object',
    properties: {
      accepted: { type: 'boolean', description: "Whether it was accepted by codectl system." },
    },
  },
}

// --- Built-in: done tool ---

export const DoneTool: ToolDefinition = {
  name: 'done',
  description:
    'Signal task completion. Call when you have finished your work. ' +
    'Pass result to return a specific value, or omit to use your last response as the result.',
  parameters: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        description: 'The final result to return. Optional.',
      },
    },
    required: [],
  },
  returns: {
    type: 'object',
    properties: {
      accepted: { type: 'boolean', description: 'User choice.' },
    },
  },
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
  readonly config: OrchestratorConfig
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly tools: ToolDefinition[] = []

  private history: Message[] = []
  private mode: Mode = { kind: 'chat' }
  private abortController: AbortController | null = null

  constructor(config: OrchestratorConfig) {
    this.adapter = config.adapter
    this.config = config
    this.profile = config.adapter.config.template

    // TODO Refactor to tool/registerBuiltin()
    // Built-in: mode
    this.registerTool(ModeTool, async (args) =>
      this.handleModeSwitch(args.mode as string)
    )

    // Built-in: done - handler is a no-op, loop detects it by name
    this.registerTool(DoneTool, async () => ({ result: { accepted: true } }))

    // Built-in: continue - handler is a no-op, loop detects it by name
    this.registerTool(ContinueTool, async () => ({ result: { continuing: true } }))

    for (const tool of config.tools ?? []) {
      this.tools.push(tool)
    }
  }

  // --- Public API ---

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.push(def)
    this.handlers.set(def.name, handler)
  }

  getMode(): Mode { return this.mode }
  getHistory(): Message[] { return [...this.history] }
  setHistory(history: Message[]): void { this.history = [...history] }

  clearHistory(): void {
    this.history = []
    this.rebuildSystemMessage()
  }

  abort(): void { this.abortController?.abort() }

  async chat(userMessage: string): Promise<TurnResult> {
    this.abortController = new AbortController()

    if (this.history.length === 0) this.rebuildSystemMessage()

    this.history.push({ role: 'user', content: userMessage })

    const toolsExecuted: TurnResult['toolsExecuted'] = []
    const maxTurns = this.config.autonomousTurns ?? 16
    let finalTurn: ParsedTurn = { content: '' }
    let doneResult: string | undefined

    for (let turn = 0; turn < maxTurns; turn++) {
      const messages = this.buildMessages()

      const parsed = await this.adapter.generate(messages)

      finalTurn = parsed

      // Content turn with no tool calls - model is done, break
      if (parsed.content && !parsed.toolCalls?.length) {
        this.history.push({ role: 'assistant', content: parsed.content })
        break
      }

      // Record content if present alongside tool calls
      if (parsed.content) {
        this.history.push({ role: 'assistant', content: parsed.content })
      }

      // No content, no tool calls - model stalled, break
      if (!parsed.toolCalls?.length) break

      // Push tool call turn
      this.history.push({ role: 'tool_call', content: parsed.toolCalls.join('\n') })

      let shouldStop = false
      let shouldContinue = false

      consola.trace('received tool calls:', parsed.toolCalls)

      for (const rawCall of parsed.toolCalls) {
        let calls: ToolCall[]

        try {
          calls = parseToolCalls(rawCall)

        } catch (err) {
          const result: ToolResult = { result: null, error: `Failed to parse tool call: ${err}` }
          this.history.push({ role: 'tool_result', content: renderToolResult(result) })

          continue
        }

        consola.trace('parsed tool calls:', calls)

        for (const call of calls) {
          // TODO Refactor to lambdas
          if (call.name === 'done') {
            doneResult = call.arguments.result as string | undefined
            shouldStop = true
          }

          if (call.name === 'continue') {
            shouldContinue = true
          }

          const result = await this.executeToolCall(call)

          toolsExecuted.push({ call, result })
          this.history.push({ role: 'tool_result', content: renderToolResult(result) })
        }
      }

      if (shouldStop) break
      // shouldContinue - just keeps looping, already counted as a turn
    }

    // done with explicit result overrides last content turn
    if (doneResult !== undefined) {
      finalTurn = { ...finalTurn, content: doneResult }
    }

    // TODO
    return { turn: finalTurn, toolsExecuted }
  }

  // --- Internals ---

  private buildMessages(): Message[] {
    if (this.tools.length === 0) return this.history

    const toolsContent = renderTools(this.tools, this.config.toolFormat ?? 'json')
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
    if (!handler) return { result: null, error: `Unknown tool: ${call.name}` }

    try {
      return await handler(call.arguments)

    } catch (err) {
      return { result: null, error: String(err) }
    }
  }

  private async handleModeSwitch(targetMode: string): Promise<ToolResult> {
    if (targetMode === 'chat') {
      this.mode = { kind: 'chat' }
      this.rebuildSystemMessage()

      return { result: { switched: 'chat' } }
    }

    if (targetMode === 'code/plan') {
      const gitRoot = await findGitRoot(process.cwd())
      let errMsg = undefined

      if (!gitRoot) {
        errMsg = 'No git repository found in current directory or any parent'
      }

      this.mode = { kind: 'code/plan', gitRoot: gitRoot ?? '' }
      this.rebuildSystemMessage()

      return { result: { switched: targetMode, result: gitRoot, error: errMsg } }
    }

    return { result: null, error: `Unknown mode: ${targetMode}` }
  }

  // TODO
  private defaultSystemPrompt(): string {
    return `You're in codectl system. You can have general conversations and help with code tasks.

In code/plan mode you can:
- Access to codeq additional information
- Explore the repository structure
- Generate a CodePlan describing code modifications

Tools are your hands, you must acknowledge tool results.
You must use token tool calls syntax, like this: [TOOL_CALLS]...[CALL_ID]...[ARGS]...`
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
    toolFormat: 'typescript',
  })

  consola.log('=== chat (no tools) ===')
  const r1 = await orchestrator.chat('Hi. Say hello in one sentence.')
  consola.log(r1.turn.content)
  consola.log('mode:', orchestrator.getMode())

  consola.log('\n=== mode switch ===')
  const r2 = await orchestrator.chat('Switch to code/plan mode using tool calls.')
  consola.log(r2.turn.content)
  consola.log('mode:', orchestrator.getMode())
  consola.log('tools executed:', r2.toolsExecuted)

  consola.log('\n=== tools list ===')
  const r3 = await orchestrator.chat('List available tools.')
  consola.log(r3.turn.content)
  consola.log('mode:', orchestrator.getMode())
}
