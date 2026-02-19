import { consola } from "consola"
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
import { lstat } from "node:fs/promises"
import { readFile } from "node:fs/promises"

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

// --- Built-in Tools ---

export const ContinueTool: ToolDefinition = {
  name: 'continue',
  description: 'Signal that you need more turns to complete the task.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why you need to continue.' },
    },
    required: [],
  },
  returns: {
    type: 'object',
    properties: { accepted: { type: 'boolean' } },
  },
}

export const DoneTool: ToolDefinition = {
  name: 'done',
  description: 'Signal task completion. Optionally pass a result value.',
  parameters: {
    type: 'object',
    properties: {
      result: { type: 'string', description: 'The final result.' },
    },
    required: [],
  },
  returns: {
    type: 'object',
    properties: { accepted: { type: 'boolean' } },
  },
}

// --- Helpers ---

async function pathExists(path: string): Promise<false | "file" | "dir"> {
  try {
    const stat = await lstat(path)

    if (stat.isDirectory()) return "dir"

    if (stat.isFile()) return "file"

    return false

  } catch {
    return false
  }
}

export async function findGitRoot(startDir: string): Promise<string | null> {

  let current = resolve(startDir)

  while (true) {

    const gitPath = join(current, ".git")

    const type = await pathExists(gitPath)

    // normal repo
    if (type === "dir") {
      return current
    }

    // worktree / submodule
    if (type === "file") {

      const content = await readFile(gitPath, "utf8")

      const match = content.match(/^gitdir:\s*(.+)$/m)

      if (!match) {
        return current
      }

      let gitDir = match[1]!.trim()

      if (!isAbsolute(gitDir)) {
        gitDir = resolve(current, gitDir)
      }

      return dirname(gitDir)
    }

    const parent = dirname(current)

    if (parent === current) {
      return null
    }

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
    // Register built-ins
    this.registerTool(ModeTool, async (args) =>
      this.handleModeSwitch(args.mode as string)
    )
    this.registerTool(DoneTool, async () => ({ result: { accepted: true } }))
    this.registerTool(ContinueTool, async () => ({ result: { continuing: true } }))

    // Register user tools
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

    // Ensure system message exists
    if (this.history.length === 0) this.rebuildSystemMessage()

    this.history.push({ role: 'user', content: userMessage })

    const toolsExecuted: TurnResult['toolsExecuted'] = []
    const maxTurns = this.config.autonomousTurns ?? 16
    let finalTurn: ParsedTurn = { content: '' }
    let doneResult: string | undefined

    // Label the loop so we can break from inside nested structures if needed
    outerLoop: for (let turn = 0; turn < maxTurns; turn++) {
      // Check abort signal
      if (this.abortController.signal.aborted) break

      const messages = this.buildMessages()

      const parsed = await this.adapter.generate(messages)

      finalTurn = parsed

      // Handle content
      if (parsed.content) {
        this.history.push({ role: 'assistant', content: parsed.content })
      }

      // Stop if no tools called
      if (!parsed.toolCalls?.length) {
        break outerLoop
      }

      // Process tools
      this.history.push({ role: 'tool_call', content: parsed.toolCalls.join('\n') })

      let loopShouldStop = false

      consola.trace('received tool calls:', parsed.toolCalls)

      for (const rawCall of parsed.toolCalls) {
        let calls: ToolCall[] = []
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
          // Detect special control flow tools
          if (call.name === 'done') {
            doneResult = call.arguments.result as string | undefined
            loopShouldStop = true
          }

          const result = await this.executeToolCall(call)

          toolsExecuted.push({ call, result })

          this.history.push({
            role: 'tool_result',
            content: renderToolResult(result)
          })
        }
      }

      // If 'done' was called, break the autonomous loop
      if (loopShouldStop) {
        break outerLoop
      }
    }

    // If 'done' provided a specific result override, use it as final content
    if (doneResult !== undefined) {
      finalTurn = { ...finalTurn, content: doneResult }
    }

    // TODO
    return { turn: finalTurn, toolsExecuted }
  }

  // --- Internals ---

  private buildMessages(): Message[] {
    // If no tools, just return history
    if (this.tools.length === 0) return this.history

    // Inject tools into system message for this specific request
    // This avoids permanently bloating the history state
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
    const sysMsg: Message = { role: 'system', content: base + modeContext }
    const sysIdx = this.history.findIndex((m) => m.role === 'system')

    if (sysIdx === -1) {
      this.history.unshift(sysMsg)

    } else {
      this.history[sysIdx] = sysMsg
    }
  }

  private async executeToolCall(call: ToolCall): Promise<ToolResult> {
    consola.trace("Executing tool", call)

    // TODO handler wrapper
    const handler = this.handlers.get(call.name)
    if (!handler) return { result: null, error: `Unknown tool: ${call.name}` }

    try {
      return await handler(call.arguments)

    } catch (err) {
      consola.error(`Error executing tool ${call.name}:`, err)

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
You must use token tool calls syntax.`
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
