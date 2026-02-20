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
  resolveArgs,
  renderTools,
  renderToolResult,
  ModeTool,
  CallIdCacheTool,
} from './tool'
import { lstat } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { CodeqTools, createCodeqHandlers } from "./tools/codeq"
import { ExecTools, createExecHandlers, PersistentShell } from "./tools/exec"
import { SubagentTool, createSubagentHandler } from "./tools/subagent"
import { MemoryTool, createMemoryHandler } from "./tools/memory"
import { createCallIdCacheHandler } from "./tools/callid-cache"
import { RunPlanTool, createRunPlanHandler } from "./tools/run_plan"
import type { CodePlan } from "./codeplan.schema"

// --- Types ---

/**
 * chat     - plain conversation; no autonomous tool loop.
 * agent    - full tool loop; ejects back to chat after too many consecutive failures.
 * codeplan - conversational design loop for structured code-change plans (Ansible/Codeq).
 *            The model proposes a CodePlan JSON; the system validates it and replies with
 *            schema errors or a success confirmation.
 */
export type Mode =
  | { kind: 'chat' }
  | { kind: 'agent'; gitRoot: string; consecutiveFailures: number }
  | { kind: 'codeplan'; gitRoot: string; lastPlan?: CodePlan; validationErrors?: string[] }

/** How many consecutive tool errors before the agent is ejected to chat mode. */
const AGENT_MAX_CONSECUTIVE_FAILURES = 3

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

  /** Max follow-through turns in chat mode when the model uses a tool (default: 3) */
  chatToolTurns?: number

  /** Current nesting depth (set by subagent tool) */
  depth?: number

  /** Max subagent nesting depth */
  maxDepth?: number

  /** Path to backend/ directory for Ansible subprocess. Defaults to ../backend relative to cwd. */
  backendDir?: string
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

export const LibraryTool: ToolDefinition = {
  name: 'tool_library',
  description: 'List all available tools and their documentation. Use this to explore what you can do.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
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
  private readonly memory = new Map<string, string>()
  private readonly callIdCache = new Map<string, string>()
  private readonly shell = new PersistentShell()

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
    this.registerTool(LibraryTool, async () => ({
      result: renderTools(this.tools, this.config.toolFormat ?? 'json')
    }))
    this.registerTool(MemoryTool, createMemoryHandler(this.memory))
    this.registerTool(CallIdCacheTool, createCallIdCacheHandler(this.callIdCache))

    // Register codeq tools
    const codeqHandlers = createCodeqHandlers(() => {
      const m = this.mode
      return m.kind !== 'chat' ? m.gitRoot : ''
    })

    for (const [name, handler] of Object.entries(codeqHandlers)) {
      const def = CodeqTools.find(t => t.name === name)!
      this.registerTool(def, handler)
    }

    // Register exec tools (shared persistent shell)
    const execHandlers = createExecHandlers(this.shell)
    for (const [name, handler] of Object.entries(execHandlers)) {
      const def = ExecTools.find(t => t.name === name)!
      this.registerTool(def, handler)
    }

    // Codeplan validation tool (only meaningful in codeplan mode, but always registered)
    this.registerTool(ValidatePlanTool, async (args) => this.handleValidatePlan(args))

    // Codeplan execution tool
    this.registerTool(RunPlanTool, createRunPlanHandler(
      () => this.mode.kind !== 'chat' ? this.mode.gitRoot : '',
      () => this.config.backendDir ?? join(dirname(process.cwd()), 'backend'),
      this.adapter,
    ))

    // Register subagent tool
    this.registerTool(SubagentTool, createSubagentHandler(Orchestrator, this.config))

    // Register user tools
    for (const tool of config.tools ?? []) {
      this.tools.push(tool)
    }
  }

  // --- Public API ---

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    if (this.handlers.has(def.name)) return
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

    // Chat mode allows tool calls but caps at a small number of follow-through turns
    // so the model can respond after executing a tool (e.g. tool_library → summarise).
    // Agent/codeplan modes get the full autonomous turn budget.
    const maxTurns = this.mode.kind === 'chat'
      ? (this.config.chatToolTurns ?? 5)
      : (this.config.autonomousTurns ?? 16)

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
      let loopShouldStop = false

      consola.trace('received tool calls:', parsed.toolCalls)

      for (const rawCall of parsed.toolCalls) {
        let calls: ToolCall[] = []
        try {
          calls = parseToolCalls(rawCall)
          this.history.push({
            role: 'tool_call',
            content: JSON.stringify({ raw: rawCall, calls }, null, 2),
          })

        } catch (err) {
          this.history.push({
            role: 'tool_call',
            content: JSON.stringify({ raw: rawCall, parseError: String(err) }, null, 2),
          })

          const result: ToolResult = { result: null, error: `Failed to parse tool call: ${err}` }
          this.history.push({ role: 'tool_result', content: renderToolResult(result) })
          this.recordToolFailure()

          if (this.wasEjected()) break outerLoop

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
            content: renderToolResult(result),
          })

          // Track agent-mode failure ejection
          if (result.error) {
            this.recordToolFailure()
            if (this.wasEjected()) { loopShouldStop = true; break }

          } else {
            this.resetToolFailures()
          }
        }
      }

      if (loopShouldStop) break outerLoop
    }

    // If 'done' provided a specific result override, use it as final content
    if (doneResult !== undefined) {
      finalTurn = { ...finalTurn, content: doneResult }
    }

    // TODO
    return { turn: finalTurn, toolsExecuted }
  }

  /** Called after a tool error in agent mode; ejects to chat if threshold hit. */
  private recordToolFailure(): void {
    if (this.mode.kind !== 'agent') return
    this.mode = { ...this.mode, consecutiveFailures: this.mode.consecutiveFailures + 1 }
    if (this.mode.consecutiveFailures >= AGENT_MAX_CONSECUTIVE_FAILURES) {
      consola.warn(`Agent hit ${AGENT_MAX_CONSECUTIVE_FAILURES} consecutive failures - ejecting to chat mode`)
      this.mode = { kind: 'chat' }
      this.rebuildSystemMessage()
    }
  }

  /** Returns true if we were just ejected from agent mode. */
  private wasEjected(): boolean {
    return this.mode.kind === 'chat'
  }

  private resetToolFailures(): void {
    if (this.mode.kind !== 'agent') return
    if (this.mode.consecutiveFailures > 0) {
      this.mode = { ...this.mode, consecutiveFailures: 0 }
    }
  }

  // --- Internals ---

  private buildMessages(): Message[] {
    // If no tools, just return history
    if (this.tools.length === 0) return this.history

    // CORE TOOLS that should always be in system prompt
    const coreToolNames = ['mode', 'done', 'continue', 'tool_library', 'memory']
    const coreTools = this.tools.filter(t => coreToolNames.includes(t.name))

    const toolsContent = renderTools(coreTools, this.config.toolFormat ?? 'json')
    const [systemMsg, ...rest] = this.history

    // Gradual shortening of tool results
    let userTurnIndex = 0
    const processedHistory = rest.map((msg, idx) => {
      if (msg.role === 'user') {
        userTurnIndex++
      }

      if (msg.role === 'tool_result') {
        // Find how many user turns are ahead of this message
        let turnsAhead = 0
        for (let i = idx + 1; i < rest.length; i++) {
          if (rest[i]!.role === 'user') turnsAhead++
        }

        if (turnsAhead === 0) {
          return msg // Age 0: full
        }

        try {
          // Attempt to parse and shorten
          // The result might be wrapped in tool tags, so we need to handle that
          // For now, let's do a simple string shortening if it looks like JSON
          let content = msg.content
          let prefix = ''
          let suffix = ''

          // Check for Mistral-style wrapping
          if (this.profile.toolResult && typeof this.profile.toolResult !== 'function' && 'wrap' in this.profile.toolResult) {
            const [open, close] = this.profile.toolResult.wrap
            if (content.startsWith(open) && content.endsWith(close)) {
              prefix = open
              suffix = close
              content = content.slice(open.length, -close.length)
            }
          }

          if (turnsAhead === 1) {
            // Age 1: shortened
            if (content.length > 1000) {
              content = content.slice(0, 1000) + '... (shortened)'
            }
          } else {
            // Age 2+: minimal
            // Try to see if it was an error
            if (content.includes('"error":')) {
              content = '{ "error": "original error preserved, result omitted" }'
            } else {
              content = '{ "result": "omitted" }'
            }
          }

          return { ...msg, content: prefix + content + suffix }

        } catch {
          return msg
        }
      }

      return msg
    })

    const enrichedSystem: Message = {
      role: 'system',
      // TODO refactor
      content: `${systemMsg?.content ?? ''}\n\n${this.profile.availableTools![0]}${toolsContent}${this.profile.availableTools![1]}`,
    }

    return [enrichedSystem, ...processedHistory]
  }

  private rebuildSystemMessage(): void {
    const base = this.config.systemPrompt ?? this.defaultSystemPrompt()

    const modeContext = match(this.mode)
      .with({ kind: 'chat' }, () => '')
      .with({ kind: 'agent' }, ({ gitRoot }) =>
        `\n\nYou are in AGENT mode. Use tools continuously to accomplish the user's goal. ` +
        `Call 'done' when finished. Git root: ${gitRoot || '(no git repo)'}\nShell cwd is preserved between bash calls.`
      )
      .with({ kind: 'codeplan' }, ({ gitRoot, lastPlan, validationErrors }) => {
        const planStatus = lastPlan
          ? (validationErrors?.length
            ? `\nLast plan had ${validationErrors.length} error(s): ${validationErrors.join('; ')}`
            : '\nLast plan was valid.')
          : '\nNo plan submitted yet.'
        return (
          `\n\nYou are in CODEPLAN mode. Collaborate on a CodePlan JSON with the user. ` +
          `Use 'validate_plan' to check the schema; iterate until valid. ` +
          `Git root: ${gitRoot}${planStatus}`
        )
      })
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

    // Find the definition so we can resolve aliases + positional args
    const def = this.tools.find(t => t.name === call.name)
    const resolvedArgs = def ? resolveArgs(call.arguments, def) : call.arguments

    try {
      const result = await handler(resolvedArgs)

      const args = JSON.stringify(call.arguments)
      const res = result.error ? `Error: ${result.error}` : this.shortenResult(result.result)
      consola.debug(`Action: ${call.name}(${args}) -> ${res}`)

      return result

    } catch (err) {
      consola.error(`Error executing tool ${call.name}:`, err)

      return { result: null, error: String(err) }
    }
  }

  private shortenResult(result: unknown): string {
    if (result === undefined) return 'undefined'

    const s = typeof result === 'string' ? result : JSON.stringify(result)
    if (s.length <= 200) return s

    return s.slice(0, 200) + '...'
  }

  private async handleModeSwitch(targetMode: string): Promise<ToolResult> {
    if (targetMode === 'chat') {
      this.mode = { kind: 'chat' }
      this.rebuildSystemMessage()

      return { result: { switched: 'chat' } }
    }

    if (targetMode === 'agent') {
      const gitRoot = await findGitRoot(process.cwd())

      this.mode = { kind: 'agent', gitRoot: gitRoot ?? '', consecutiveFailures: 0 }
      this.rebuildSystemMessage()

      return { result: { switched: 'agent', gitRoot } }
    }

    if (targetMode === 'codeplan') {
      const gitRoot = await findGitRoot(process.cwd())

      if (!gitRoot) return { result: null, error: 'codeplan mode requires a git repository' }

      this.mode = { kind: 'codeplan', gitRoot }
      this.rebuildSystemMessage()
      return { result: { switched: 'codeplan', gitRoot } }
    }

    return { result: null, error: `Unknown mode: ${targetMode}` }
  }

  private async handleValidatePlan(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.mode.kind !== 'codeplan') {
      return { result: null, error: 'validate_plan is only available in codeplan mode' }
    }
    const raw = args.plan ?? args.json ?? args.codeplan
    if (!raw) return { result: null, error: "'plan' argument is required" }

    let parsed: unknown
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw as string) : raw
    } catch (err) {
      return { result: null, error: `Invalid JSON: ${err}` }
    }

    try {
      const schemaModule = await import('./codeplan.schema')
      const schema = (schemaModule as any).codePlanSchema ?? (schemaModule as any).default
      if (!schema) throw new Error('schema not found')

      const result = schema.safeParse(parsed)
      if (result.success) {
        this.mode = { ...(this.mode as Extract<Mode, { kind: 'codeplan' }>), lastPlan: result.data, validationErrors: [] }
        this.rebuildSystemMessage()
        return { result: { valid: true, message: 'CodePlan is valid and ready for execution.' } }
      } else {
        const errors = result.error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`)
        this.mode = { ...(this.mode as Extract<Mode, { kind: 'codeplan' }>), validationErrors: errors }
        this.rebuildSystemMessage()
        return { result: { valid: false, errors } }
      }
    } catch (err) {
      return { result: null, error: `Schema validation failed: ${err}` }
    }
  }

  // TODO unhardcode
  private defaultSystemPrompt(): string {
    return [
      "You're the orchestrator in the codectl system.",
      "",
      "Modes:",
      "  chat     - general conversation (default, single-turn)",
      "  agent    - autonomous tool loop; call 'done' when task is complete.",
      "             Ejected back to chat after 3 consecutive tool failures.",
      "  codeplan - design a structured CodePlan JSON (Ansible-style).",
      "             Use 'validate_plan' to check schema; iterate until valid.",
      "",
      "Tools are your hands - always acknowledge results.",
      "Use token tool-call syntax: [TOOL_CALLS]...[CALL_ID]...[ARGS]",
    ].join('\n')
  }
}

// --- Validate plan tool definition (exported for registration) ---

export const ValidatePlanTool: ToolDefinition = {
  name: 'validate_plan',
  description:
    'Validate a CodePlan JSON object against the schema. ' +
    'Returns { valid: true } on success or { valid: false, errors } with schema violations. ' +
    'Only available in codeplan mode.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The CodePlan JSON to validate (as a serialised string).',
        aliases: ['json', 'codeplan'],
      },
    },
    required: ['plan'],
  },
  returns: {
    type: 'object',
    properties: {
      valid: { type: 'boolean', description: 'Whether the plan passed schema validation.' },
      errors: { type: 'string', description: 'Validation errors (when valid is false).' },
      message: { type: 'string', description: 'Success message (when valid is true).' },
    },
  },
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
