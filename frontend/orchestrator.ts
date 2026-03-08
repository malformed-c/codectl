import { consola } from "consola"
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { match } from 'ts-pattern'
import type { KoboldAdapter } from './kobold'
import type { OpenAIChatAdapter, OpenAITextAdapter } from './openai'
import type { GeminiNativeAdapter, GeminiInteractionsAdapter } from './gemini'
import type { ParsedTurn, TextTemplate } from './template'
import { turnContent, turnThink, turnToolCalls } from './template'
import type { StoredToolCall, StoredToolResult } from './types'
import {
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolFormat,
  ok, err,
  parseToolCalls,
  resolveArgs,
  renderTools,
  ModeTool,
  CallIdCacheTool,
} from './tool'
import { lstat } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { CodeqTools, createCodeqHandlers } from "./tools/codeq"
import { ExecTools, createExecHandlers, PersistentShell } from "./tools/exec"
import { SubagentTool, createSubagentHandler } from "./tools/subagent"
import { MemoryTool, createMemoryHandler } from "./tools/memory"
import { GraphMemory, GraphMemoryTool, createGraphMemoryHandler } from "./memory"
import { AskTool, MessageTool, AskChannel, createAskHandler, createMessageHandler } from "./tools/ask"
import { createCallIdCacheHandler } from "./tools/callid-cache"
import { RunPlanTool, createRunPlanHandler } from "./tools/run_plan"
import { ValidatePlanTool, createValidatePlanHandler } from "./tools/validate_plan"
import { TransformTools, createTransformHandlers } from "./tools/transform"
import type { CodePlan } from "./codeplan.schema"
import { Fsm } from './fsm'
import { RenderCache, VersionedMemory, renderHistory } from './renderer'
import { joinWithBoundaryNormalization } from './pipeline'
import { userSpan } from './span'
import { systemRound as makeSystemRound, type Round } from './round'
import { CheckpointStore, restoreLatest, type RestoredSession } from './checkpoint'


// --- Types ---

export type Mode =
  | { kind: 'chat' }
  | { kind: 'agent'; gitRoot: string; consecutiveFailures: number }

type PlanValidationState = {
  lastPlan?: CodePlan
  validationErrors: string[]
}

/** How many consecutive tool errors before the agent is ejected to chat mode. */
const AGENT_MAX_CONSECUTIVE_FAILURES = 3

export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<ToolResult>

export type LLMAdapter = KoboldAdapter | OpenAIChatAdapter | OpenAITextAdapter | GeminiNativeAdapter | GeminiInteractionsAdapter

export type OrchestratorConfig = {
  adapter: LLMAdapter
  /** Override the built-in system prompt. */
  systemPrompt?: string
  /** Extra tool definitions for the model to see (handlers must be registered separately). */
  tools?: ToolDefinition[]
  toolFormat?: ToolFormat

  /** Max autonomous turns before aborting the agent loop. Default: 16. */
  autonomousTurns?: number

  /** Max follow-through turns in chat mode when the model uses a tool. Default: 5.
   *  Allows the model to summarise tool output after e.g. tool_library -> response. */
  chatToolTurns?: number

  /** Current nesting depth - set by subagent tool to enforce the depth limit. */
  depth?: number
  /** Max subagent nesting depth before refusing to spawn another. Default: 3. */
  maxDepth?: number

  /** Path to backend/ directory for Ansible subprocess. Defaults to ../backend relative to cwd. */
  backendDir?: string

  /** Character budget for renderHistory (≈ chars, not tokens). Default: 128_000 (≈ 32K tokens). */
  contextBudget?: number

  /** Directory to write checkpoint files. If omitted, checkpointing is disabled. */
  checkpointDir?: string

  /** Keep only this many newest checkpoint-NNN.json files. latest.json is always kept. */
  checkpointKeep?: number

  /** Path to graph memory SQLite db. If provided, graph memory tool is registered. */
  graphMemoryPath?: string
}

export type TurnResult = {
  turn: ParsedTurn
  toolsExecuted: Array<{ call: ToolCall; result: ToolResult }>
}

export type OrchestratorEvent =
  | { kind: 'call'; call: ToolCall; rawArguments: Record<string, unknown>; pending: true }
  | { kind: 'call_result'; call: ToolCall; result: ToolResult }
  | { kind: 'turn'; turn: ParsedTurn; toolsExecuted: TurnResult['toolsExecuted'] }

/**
 * Drain an orchestrator generator to completion, ignoring intermediate events.
 * Useful for headless callers (subagents, tests) that only need the final result.
 */
export async function toPromise(
  gen: AsyncGenerator<OrchestratorEvent, TurnResult>,
): Promise<TurnResult> {
  let step: IteratorResult<OrchestratorEvent, TurnResult>

  while (!(step = await gen.next()).done) { }

  return step.value
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
  description: 'List available tools and their documentation. Use this to explore what you can do.',
  parameters: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Optional prefix to filter tools by name.',
      },
    },
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
  private readonly adapter: LLMAdapter
  private readonly profile: TextTemplate
  readonly config: OrchestratorConfig
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly tools: ToolDefinition[] = []
  private readonly versionedMemory = new VersionedMemory()
  private readonly callIdCache = new Map<string, string>()
  private readonly shell = new PersistentShell()
  private readonly renderCache = new RenderCache()

  private fsm = new Fsm()
  private _systemRound: Round = makeSystemRound('')
  private _enrichedSystemRound: Round = makeSystemRound('')  // cached: _systemRound + tools block
  private mode: Mode = { kind: 'chat' }
  private _ejectedThisTurn = false
  private planValidationState: PlanValidationState = { validationErrors: [] }
  private abortController: AbortController | null = null
  private readonly checkpointStore: CheckpointStore | null
  private readonly askChannel = new AskChannel()

  constructor(config: OrchestratorConfig) {
    this.adapter = config.adapter
    this.config = config
    this.profile = config.adapter.config.template
    this.checkpointStore = config.checkpointDir
      ? new CheckpointStore(config.checkpointDir, config.checkpointKeep)
      : null

    // --- Built-in tools ---
    this.registerTool(ModeTool, async (args) => this.handleModeSwitch(args.mode as string))
    this.registerTool(DoneTool, async () => ok({ accepted: true }))
    this.registerTool(ContinueTool, async () => ok({ continuing: true }))
    this.registerTool(LibraryTool, async (args) => {
      const prefix = args.prefix as string | undefined
      const tools = prefix
        ? this.tools.filter(t => t.name.startsWith(prefix))
        : this.tools

      const rendered = renderTools(tools, this.config.toolFormat ?? 'json')
      const wrapped = this.profile.availableTools
        ? `${this.profile.availableTools[0]}${rendered}${this.profile.availableTools[1]}`
        : rendered

      return ok(wrapped)
    })
    this.registerTool(MemoryTool, createMemoryHandler(this.versionedMemory))

    if (this.config.graphMemoryPath) {
      const gm = new GraphMemory(this.config.graphMemoryPath)
      this.registerTool(GraphMemoryTool, createGraphMemoryHandler(gm))
    }
    this.registerTool(CallIdCacheTool, createCallIdCacheHandler(this.callIdCache))
    this.registerTool(AskTool, createAskHandler(this.askChannel))
    this.registerTool(MessageTool, createMessageHandler())
    this.registerTool(ValidatePlanTool, createValidatePlanHandler((lastPlan, errors) => {
      // Update plan validation state and rebuild the system prompt so the model always
      // sees the latest validation status in its context (last plan valid/invalid + errors).
      this.planValidationState = { lastPlan, validationErrors: errors }
      this.rebuildSystemMessage()
    }))
    this.registerTool(RunPlanTool, createRunPlanHandler(
      () => this.shell.getCwd(),
      () => this.config.backendDir ?? join(dirname(process.cwd()), 'backend'),
      this.adapter,
    ))
    this.registerTool(SubagentTool, createSubagentHandler(Orchestrator, this.config))

    // --- Tool-set registrations (def + handler paired by name) ---
    this.registerToolSet(CodeqTools, createCodeqHandlers(() => this.shell.getCwd()))
    this.registerToolSet(ExecTools, createExecHandlers(this.shell))
    this.registerToolSet(TransformTools, createTransformHandlers(this.versionedMemory, {
      getCommitted: () => this.fsm.getRenderableHistory().map(r => r.serialize()),
    }))

    // --- User-supplied tools (definitions only; handlers registered by caller) ---
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

  /**
   * Register a set of tools from a definition array + handler map (keyed by name).
   * Silently skips names already registered.
   */
  registerToolSet(defs: ToolDefinition[], handlers: Record<string, ToolHandler>): void {
    for (const [name, handler] of Object.entries(handlers)) {
      const def = defs.find(d => d.name === name)

      if (!def) { consola.warn(`[registerToolSet] no definition found for handler "${name}"`); continue }

      this.registerTool(def, handler)
    }
  }

  getMode(): Mode { return this.mode }
  getHistory(): Round[] { return [...this.fsm.history] }
  getMemory(): VersionedMemory { return this.versionedMemory }

  /** True when the model has called `ask` and is waiting for a user reply. */
  hasPendingAsk(): boolean { return this.askChannel.hasPending }

  /** The question the model is waiting on, if any. */
  getPendingQuestion(): string | undefined { return this.askChannel.pendingQuestion }

  /**
   * Resolve a pending `ask` call with the user's answer.
   * Returns true if there was a pending ask, false if there wasn't one.
   * When true, the answer is injected as the tool result and the agent loop resumes.
   */
  resolveAsk(answer: string): boolean { return this.askChannel.resolveAsk(answer) }

  /**
   * Full session reset: clears FSM history, memory, and mode back to chat.
   * Saves an empty checkpoint so the next restoreCheckpoint() call finds nothing.
   * This is the correct way to start a new conversation (replaces the old clearHistory()).
   */
  async resetSession(): Promise<void> {
    this.askChannel.abort('Session was reset.')

    // Archive the current checkpoint dir before wiping state
    if (this.checkpointStore) {
      await this.checkpointStore.archiveSession()
    }

    this.fsm = new Fsm()
    this.versionedMemory.clear()
    this.mode = { kind: 'chat' }
    this.rebuildSystemMessage()

    // Write an empty checkpoint so restore on next message is a no-op.
    await this._saveCheckpoint()
  }

  abort(): void {
    this.abortController?.abort()
    this.askChannel.abort('Orchestrator was aborted.')
  }

  /**
   * Restore session state from the latest checkpoint.
   * Replaces FSM history and versioned memory with persisted state.
   * Returns the restored session or null if no checkpoint exists.
   */
  async restoreCheckpoint(): Promise<RestoredSession | null> {
    if (!this.checkpointStore) return null

    const session = await restoreLatest(this.checkpointStore)
    if (!session) return null

    // Re-populate FSM history from deserialized rounds
    this.fsm = new Fsm()
    this.fsm.hydrate(session.history)

    // Restore memory
    this.versionedMemory.clear()
    for (const [k, v] of session.memory.entries()) {
      this.versionedMemory.set(k, v)
    }

    // Restore mode
    if (session.modeKind === 'agent' && this.mode.kind !== 'agent') {
      this.mode = { kind: 'agent', gitRoot: '', consecutiveFailures: 0 }
    }

    this.rebuildSystemMessage()

    consola.info(`[checkpoint] restored ${session.history.length} rounds`)

    return session
  }

  /** Manually trigger a checkpoint save (e.g. on graceful shutdown). */
  async saveCheckpoint(): Promise<void> {
    await this._saveCheckpoint()
  }

  /**
   * Headless agent run: injects the goal into the system prompt and starts the
   * autonomous loop without a user turn. The model talks only with the system.
   * Automatically switches to agent mode if not already in it.
   */
  async *run(goal: string): AsyncGenerator<OrchestratorEvent, TurnResult> {
    if (this.mode.kind !== 'agent') {
      this.mode = { kind: 'agent', gitRoot: '', consecutiveFailures: 0 }
    }

    // Reset FSM, inject goal into system message - no user turn
    this.fsm = new Fsm()
    this.rebuildSystemMessage(goal)

    return yield* this.runLoop()
  }

  async *chat(userMessage: string): AsyncGenerator<OrchestratorEvent, TurnResult> {
    // Ensure system message exists
    if (this._systemRound.count === 0) this.rebuildSystemMessage()

    this.fsm.onUser([userSpan(userMessage)])

    return yield* this.runLoop()
  }

  /**
   * Convenience wrapper: runs chat() to completion and returns the final TurnResult.
   * Intermediate events are discarded. Use chat() directly when you need streaming.
   */
  async complete(userMessage: string): Promise<TurnResult> {
    return toPromise(this.chat(userMessage))
  }

  private async *runLoop(): AsyncGenerator<OrchestratorEvent, TurnResult> {
    this.abortController = new AbortController()
    this._ejectedThisTurn = false

    const toolsExecuted: TurnResult['toolsExecuted'] = []

    // Chat mode allows tool calls but caps at a small number of follow-through turns.
    // so the model can respond after executing a tool (e.g. tool_library -> summarise).
    // Agent mode gets the full autonomous turn budget.
    const maxTurns = this.mode.kind === 'chat'
      ? (this.config.chatToolTurns ?? 5)
      : (this.config.autonomousTurns ?? 16)

    let finalTurn: ParsedTurn = { steps: [] }
    let doneResult: string | undefined
    let loopShouldStop = false

    // Label the loop so we can break from inside nested structures if needed
    outerLoop: for (let turn = 0; turn < maxTurns; turn++) {
      // Check abort signal
      if (this.abortController.signal.aborted) break

      const prompt = this.buildPrompt()

      const parsed = await this.adapter.generateRaw(prompt)

      finalTurn = parsed

      // Detect think-only output: model produced reasoning but no content and no tool calls.
      // Punish with a system correction so it completes the turn.
      const think   = turnThink(parsed)
      const content  = turnContent(parsed)
      const calls    = turnToolCalls(parsed)

      const isThinkOnly = think && !content && !calls.length
      if (isThinkOnly) {
        consola.warn('[think-only] model produced reasoning with no content/tools - injecting correction')

        this.fsm.onModel(think, undefined, [])
        this.fsm.onSystem(
          'You forgot to close your reasoning tag or produce a response. ' +
          'Your reasoning tags are [THINK][/THINK]. ' +
          'Please complete your response now with either a tool call or a final message.'
        )

        continue
      }

      // Stop if no tools called - commit ChatRound via FSM
      if (!calls.length) {
        this.fsm.onModel(think, content, [])
        void this._saveCheckpoint()

        yield { kind: 'turn', turn: parsed, toolsExecuted: [] }

        break outerLoop
      }

      // #23: Malformed token correction
      if (parsed.malformed) {
        consola.warn('Malformed tool call: closing token found without opening token.')

        this.fsm.onError('Malformed tool call: your response contained a closing tool token without the opening token. Always start tool calls with the opening token.')
        this.recordToolFailure()
      }

      // Build ToolCall / StoredToolCall arrays from already-parsed steps
      loopShouldStop = false
      const turnTools: TurnResult['toolsExecuted'] = []
      const allCalls: ToolCall[] = []
      const storedCalls: StoredToolCall[] = []
      const immediateResults: StoredToolResult[] = []

      if (calls.length) {
        consola.info('received tool calls:', calls.map(c => c.name))

        for (const step of calls) {
          // Resolve $var / ${var} variable references in arguments before execution
          const resolvedArgs = resolveMemoryVars(step.arguments, this.versionedMemory)

          const call: ToolCall = { name: step.name, callId: step.callId, arguments: resolvedArgs }
          allCalls.push(call)
          yield { kind: 'call', call, rawArguments: step.arguments, pending: true }
          storedCalls.push({
            tool: call.name,
            ...(call.callId ? { callId: call.callId } : {}),
            ...call.arguments,
          })
        }
      }

      if (storedCalls.length > 0) {
        // Signal model turn with calls to FSM - opens ToolRound
        this.fsm.onModel(think, content, storedCalls)

        // Yield model text FIRST so the UI can display it before tool notifications.
        // toolsExecuted is empty here; callers that need full results use call_result events
        // or the TurnResult returned from the generator.
        yield { kind: 'turn', turn: parsed, toolsExecuted: [] }

        const storedResults: StoredToolResult[] = []

        for (const call of allCalls) {
          // Detect special control flow tools
          if (call.name === 'done') {
            doneResult = call.arguments.result as string | undefined
            loopShouldStop = true
          }

          const result = await this.executeToolCall(call)

          // Inject ask replies and message content into the agent context as
          // system rounds so the model sees them as first-class conversation turns
          // rather than opaque tool result JSON.
          if (call.name === 'ask' && result.ok) {
            const answer = (result.value as Record<string, unknown>).answer as string
            if (answer) this.fsm.onSystem(`[User]: ${answer}`)

          } else if (call.name === 'message' && result.ok) {
            const content = call.arguments.content as string
            if (content) this.fsm.onSystem(`[Sent to user]: ${content}`)
          }

          yield { kind: 'call_result', call, result }

          turnTools.push({ call, result })
          toolsExecuted.push({ call, result })

          storedResults.push({
            callId: result.callId,
            error: result.ok ? undefined : result.error,
            value: result.ok ? result.value : null,
          })

          // Track agent-mode failure ejection
          // #22: Count explicit errors AND null results (handler returned nothing useful) as failures.
          if (!result.ok || result.value === null) {
            this.recordToolFailure()

            if (this.wasEjected()) { loopShouldStop = true; break }

          } else {
            this.resetToolFailures()
          }
        }

        // Combine immediate parse errors with executed tool results to match storedCalls length
        const allResults = [...storedResults, ...immediateResults]

        consola.info('storing tool results in history:', this.shortenStoredResults(allResults))

        // Commit ToolRound - pairs with the onModel call above
        this.fsm.onResults(allResults)

        if (loopShouldStop) {
          this.fsm.onDone(doneResult)
        }

        void this._saveCheckpoint()

      } else if (calls.length > 0 && !parsed.malformed) {
        // Failsafe: had tool_call steps but storedCalls is 0, FSM must not be locked.
        this.fsm.onModel(think, content, [])

        yield { kind: 'turn', turn: parsed, toolsExecuted: [] }

        break outerLoop
      }

      if (loopShouldStop) break outerLoop
    }

    if (!loopShouldStop) {
      // Turn limit or abort - force-close any open agent run
      this.fsm.onAbort()
    }

    // If 'done' provided a specific result override, use it as final content
    if (doneResult !== undefined) {
      finalTurn = { ...finalTurn, steps: [{ kind: 'text' as const, text: doneResult }] }
    }

    return { turn: finalTurn, toolsExecuted }
  }

  /** Save a checkpoint if a store is configured. Fire-and-forget safe (awaited internally). */
  private async _saveCheckpoint(): Promise<void> {
    if (!this.checkpointStore) return

    const modeKind = this.mode.kind === 'agent' ? 'agent' : 'chat'

    await this.checkpointStore.save(
      this.fsm.history,
      this.versionedMemory,
      modeKind,
      this.fsm.cursor,
    )
  }

  /** Called after a tool error in agent mode; ejects to chat if threshold hit. */
  private recordToolFailure(): void {
    if (this.mode.kind !== 'agent') return
    this.mode = { ...this.mode, consecutiveFailures: this.mode.consecutiveFailures + 1 }
    if (this.mode.consecutiveFailures >= AGENT_MAX_CONSECUTIVE_FAILURES) {

      consola.warn(`Agent hit ${AGENT_MAX_CONSECUTIVE_FAILURES} consecutive failures - ejecting to chat mode`)

      this.mode = { kind: 'chat' }
      this._ejectedThisTurn = true
      this.rebuildSystemMessage()
    }
  }

  /** Returns true if we were just ejected from agent mode (i.e. we were agent, now chat). */
  private wasEjected(): boolean {
    // consecutiveFailures is only tracked in agent mode; if we just hit the threshold
    // recordToolFailure switches mode to chat. A bare mode.kind === 'chat' check would
    // always fire in chat mode and break the loop after every tool error.
    return this.mode.kind === 'chat' && this._ejectedThisTurn
  }

  private resetToolFailures(): void {
    if (this.mode.kind !== 'agent') return

    if (this.mode.consecutiveFailures > 0) {
      this.mode = { ...this.mode, consecutiveFailures: 0 }
    }
  }

  // --- Internals ---

  /** Render the full history to a prompt string via renderHistory(). */

  private buildPrompt(): string {
    const history = [this._enrichedSystemRound, ...this.fsm.getRenderableHistory()]
    const budget = this.config.contextBudget ?? 128_000

    const { text } = renderHistory(history, this.versionedMemory, this.profile, {
      budget,
      cache: this.renderCache,
    })

    return text
  }

  /**
   * Rebuild the cached enriched system round (base content + tool definitions).
   * Called from rebuildSystemMessage after updating _systemRound.
   * Keeps the same Round object identity if content hasn't changed to preserve
   * the WeakMap cache entry in RenderCache.
   */
  private _rebuildEnrichedSystem(): void {
    const coreToolNames = ['mode', 'done', 'continue', 'tool_library', 'memory']
    const coreTools = this.tools.filter(t => coreToolNames.includes(t.name))
    const toolsContent = renderTools(coreTools, this.config.toolFormat ?? 'json')
    const toolsBlock = this.profile.availableTools
      ? `${this.profile.availableTools[0]}${toolsContent}${this.profile.availableTools[1]}`
      : ''

    const sysContent = this._systemRound.spans({ age: 0, memory: new Map(), budget: Infinity })
      .map(s => s.text).join('')
    const fullContent = joinWithBoundaryNormalization([sysContent, toolsBlock])

    this._enrichedSystemRound = makeSystemRound(fullContent)
    this._enrichedSystemRound.count = fullContent.length
  }

  private rebuildSystemMessage(agentGoal?: string): void {
    const base = this.config.systemPrompt ?? this.defaultSystemPrompt()

    const modeContext = match(this.mode)
      .with({ kind: 'chat' }, () => '')
      .with({ kind: 'agent' }, () => {
        const goalPart = agentGoal
          ? `\n\nGOAL:\n${agentGoal}`
          : ''

        return (
          `\n\nYou are in AGENT mode. Use tools continuously to accomplish the user's goal. ` +
          `Call 'done' when finished. Use 'bash' to navigate to a repo (cd) before running plans.` +
          goalPart
        )
      })
      .exhaustive()

    const planStatus = this.planValidationState.lastPlan
      ? (this.planValidationState.validationErrors.length
        ? `\nLast plan had ${this.planValidationState.validationErrors.length} error(s): ${this.planValidationState.validationErrors.join('; ')}`
        : '\nLast plan was valid.')
      : '\nNo plan submitted yet.'

    const workflowContext = `\n\nCodePlan workflow:\nUse 'validate_plan' to check structured CodePlan JSON before running it.${planStatus}`

    this._systemRound = makeSystemRound(base + modeContext + workflowContext)
    this._systemRound.count = (base + modeContext + workflowContext).length
    this._rebuildEnrichedSystem()
  }

  private async executeToolCall(call: ToolCall): Promise<ToolResult> {
    consola.trace("Executing tool", call)

    // Find the handler, falling back to an unknown-tool error.
    // Future: add a middleware wrapper here for logging, timeouts, and per-tool sandboxing.
    const handler = this.handlers.get(call.name)
    if (!handler) return err(`Unknown tool: ${call.name}`)

    // Find the definition so we can resolve aliases + positional args
    const def = this.tools.find(t => t.name === call.name)
    const resolvedArgs = def ? resolveArgs(call.arguments, def) : { ...call.arguments }

    // --- Automatic Call-ID Resolution ---
    for (const [key, val] of Object.entries(resolvedArgs)) {
      if (typeof val === 'string' && this.callIdCache.has(val)) {
        const cachedValue = this.callIdCache.get(val)
        resolvedArgs[key] = cachedValue
        consola.debug(`Auto-resolved arg '${key}': ${val} -> (cached value)`)
      }
    }

    // --- #24: Memory Variable Interpolation ---
    // Substitute $key or ${key} references in string args with memory values.
    for (const [key, val] of Object.entries(resolvedArgs)) {
      if (typeof val === 'string' && val.includes('$')) {
        resolvedArgs[key] = val.replace(/\$\{([^}]+)\}|\$([\w]+)/g, (_match, braced, bare) => {
          const memKey = braced ?? bare
          const memVal = this.versionedMemory.get(memKey)
          if (memVal !== undefined) {
            consola.debug(`Memory interpolation: $${memKey} -> (value)`)

            return memVal
          }

          return _match // leave unresolved refs as-is
        })
      }
    }

    try {
      const result = await handler(resolvedArgs)

      // Ensure callId is preserved if not returned by handler
      if (!result.callId && call.callId) {
        (result as { callId?: string }).callId = call.callId
      }

      const args = JSON.stringify(call.arguments)
      const res = result.ok ? this.shortenResult(result.value) : `Error: ${result.error}`
      consola.info(`Action: ${call.name}(${args}) -> ${res}`)

      // --- Automatic Call-ID Caching ---
      if (result.callId && result.ok && result.value !== undefined) {
        const cacheValue = typeof result.value === 'string'
          ? result.value
          : JSON.stringify(result.value)

        this.callIdCache.set(result.callId, cacheValue)
        consola.debug(`Auto-cached result for ${result.callId}`)
      }

      return result

    } catch (e) {
      consola.error(`Error executing tool ${call.name}:`, e)

      return err(String(e))
    }
  }

  private shortenResult(result: unknown): string {
    if (result === undefined) return 'undefined'

    const s = typeof result === 'string' ? result : JSON.stringify(result)
    if (s.length <= 200) return s

    return s.slice(0, 200) + '...'
  }

  private shortenStoredResults(results: StoredToolResult[]): string {
    return JSON.stringify(results.map(r => ({
      ...r,
      value: r.value !== undefined ? this.shortenResult(r.value) : undefined
    })))
  }

  private async handleModeSwitch(targetMode: string): Promise<ToolResult> {
    if (targetMode === 'chat') {
      this.mode = { kind: 'chat' }
      this.rebuildSystemMessage()

      return ok({ switched: 'chat' })
    }

    if (targetMode === 'agent') {
      this.mode = { kind: 'agent', gitRoot: '', consecutiveFailures: 0 }
      this.rebuildSystemMessage()

      return ok({ switched: 'agent', cwd: this.shell.getCwd() })
    }

    return err(`Unknown mode: ${targetMode}`)
  }

  /**
   * Default system prompt used when OrchestratorConfig.systemPrompt is not set.
   * Describes the two modes (chat/agent), the think-block format, and tool-call syntax.
   * Override via config.systemPrompt if you need custom instructions.
   */
  // TODO unhardcode
  private defaultSystemPrompt(): string {
    return [
      "You're the orchestrator in the codectl agentic system.",
      "",
      "Modes:",
      "  chat - general conversation (single-turn)",
      "  agent - autonomous tool loop; call 'done' when task is complete.",
      "Ejected back to chat after 3 consecutive tool failures.",
      "",
      "# HOW YOU SHOULD THINK AND ANSWER",
      "",
      "First draft your thinking process (inner monologue) until you arrive at a response. Format your response using Markdown, and use LaTeX for any mathematical equations. Write both your thoughts and the response in the same language as the input.",
      "",
      "Your thinking process must follow the template below:",
      "[THINK]Your thoughts or/and draft, like working through an exercise on scratch paper. You must start reasoning with open tag. Be as casual and as long as you want until you are confident to generate the response to the user.[/THINK]",
      "Here, provide a self-contained response.",
      "Tools are your hands - always acknowledge results.",
      "Use token tool-call syntax: [TOOL_CALLS]...[CALL_ID]...[ARGS]",
      "You can call multiple tools in one turn."
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// Variable resolution: substitute $key / ${key} from VersionedMemory
// ---------------------------------------------------------------------------

/**
 * Walk every string value in args and replace $key / ${key} references with
 * the corresponding value from the session memory store.
 * Non-string values (numbers, booleans, arrays, objects) are left untouched.
 */
function resolveMemoryVars(
  args: Record<string, unknown>,
  memory: VersionedMemory,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    resolved[k] = typeof v === 'string' ? substituteVars(v, memory) : v
  }
  return resolved
}

function substituteVars(text: string, memory: VersionedMemory): string {
  // ${key} form — match first so it takes priority
  text = text.replace(/\${([^}]+)}/g, (_, key: string) => memory.get(key) ?? `\${${key}}`)
  // $key form — word-char sequence after $
  text = text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => memory.get(key) ?? `$${key}`)
  return text
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
  const r1 = await orchestrator.complete('Hi. Say hello in one sentence.')
  consola.log(turnContent(r1.turn))
  consola.log('mode:', orchestrator.getMode())

  consola.log('\n=== mode switch ===')
  const r2 = await orchestrator.complete('Switch to agent mode using tool calls.')
  consola.log(turnContent(r2.turn))
  consola.log('mode:', orchestrator.getMode())
  consola.log('tools executed:', r2.toolsExecuted)

  consola.log('\n=== tools list ===')
  const r3 = await orchestrator.complete('List available tools.')
  consola.log(turnContent(r3.turn))
  consola.log('mode:', orchestrator.getMode())
}
