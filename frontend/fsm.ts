import consola from 'consola'
import type { Span } from './span'
import { countSpanChars } from './span'
import type { StoredToolCall, StoredToolResult } from './types'
import {
  chatRound, agentRound, toolRound, systemRound, errorRound,
  type Round, type History,
} from './round'

// --- FSM States ---

type StateIdle = {
  kind: 'idle'
}

/** User message received, waiting for first model response. */
type StateAwaitingModel = {
  kind: 'awaiting_model'
  userSpans: Span[]
}

/**
 * Inside an AgentRound. Tool calls made, waiting for their results.
 * Strict: the FSM will not accept another model turn until results arrive.
 */
type StateAwaitingResults = {
  kind: 'awaiting_results'
  userSpans: Span[]      // null for headless run()
  agentChildren: Round[]
  pendingCalls: StoredToolCall[]
  pendingThink?: string
  pendingContent?: string
}

/**
 * Inside an AgentRound. Last ToolRound committed, ready for next model turn.
 */
type StateInAgent = {
  kind: 'in_agent'
  userSpans: Span[]
  agentChildren: Round[]
}

type FsmState =
  | StateIdle
  | StateAwaitingModel
  | StateAwaitingResults
  | StateInAgent

// --- Fsm ---

/**
 * Pass 1: Incremental FSM ingest.
 *
 * Consumes a stream of events from the orchestrator and builds the History[]
 * round tree. Commits rounds at natural boundaries:
 *   - ChatRound:  when the model responds with text only (no tool calls)
 *   - ToolRound:  when calls + results are paired
 *   - AgentRound: when the agent run concludes (text-only response or done)
 *
 * Invalid transitions produce ErrorRounds instead of silently corrupting state.
 * The cursor field always equals history.length - used by CheckpointStore.
 */
export class Fsm {
  readonly history: History = []
  private state: FsmState = { kind: 'idle' }

  /** Index of the first uncommitted round. For CheckpointStore.save(). */
  get cursor(): number { return this.history.length }

  /**
   * Returns the full history including pending rounds that are currently being built.
   * Used by the orchestrator to render the current prompt.
   */
  getRenderableHistory(): Round[] {
    const history = [...this.history]

    switch (this.state.kind) {
      case 'awaiting_model':
        history.push(chatRound(this.state.userSpans, ''))

        break

      case 'awaiting_results':
        if (this.state.userSpans.length > 0) {
          history.push(chatRound(this.state.userSpans, ''))
        }
        history.push(agentRound([
          ...this.state.agentChildren,
          toolRound(
            this.state.pendingCalls,
            [],
            this.state.pendingThink,
            this.state.pendingContent
          )
        ]))

        break

      case 'in_agent':
        if (this.state.userSpans.length > 0) {
          history.push(chatRound(this.state.userSpans, ''))
        }
        history.push(agentRound(this.state.agentChildren))

        break
    }

    return history
  }

  // --- Events ---

  /**
   * User sent a message. Must be called before the orchestrator loop starts.
   * For headless run() with no user turn, skip this and go straight to onModel.
   */
  onUser(userSpans: Span[]): void {
    if (this.state.kind === 'awaiting_model') {
      // Already waiting for a response to a previous message.
      // Append the new message to the existing one.
      if (userSpans.length > 0) {
        this.state.userSpans.push({ kind: 'content', text: '\n\n' })
        this.state.userSpans.push(...userSpans)
      }

      return
    }

    if (this.state.kind !== 'idle') {
      // Unexpected user turn (e.g. interruption during agent run).
      // Force-close any open agent run then accept the user message.
      consola.warn(`[FSM] onUser in state=${this.state.kind}, force-closing`)

      this._forceClose()
    }

    this.state = { kind: 'awaiting_model', userSpans }
  }

  /**
   * Model produced a response (think + content + optional tool calls).
   * This is called once per adapter.generate() invocation.
   */
  onModel(think: string | undefined, content: string | undefined, calls: StoredToolCall[]): void {
    const hasCalls = calls.length > 0

    switch (this.state.kind) {

      // -- awaiting_model: first model response after user turn ---
      case 'awaiting_model': {
        if (!hasCalls) {
          // Text-only: simple chat exchange. Commit ChatRound.
          const round = chatRound(this.state.userSpans, content ?? '', think)
          this._commit(round)
          this.state = { kind: 'idle' }

          return
        }

        // Commit the user turn immediately so it precedes the AgentRound in history
        if (this.state.userSpans.length > 0) {
          this._commit(chatRound(this.state.userSpans, ''))
        }

        // Has calls: open an AgentRound, transition to awaiting_results.
        this.state = {
          kind: 'awaiting_results',
          userSpans: [], // Consumed by the commit above
          agentChildren: [],
          pendingCalls: calls,
          pendingThink: think,
          pendingContent: content,
        }

        return
      }

      // -- in_agent: subsequent model turn inside an agent run ---
      case 'in_agent': {
        if (!hasCalls) {
          // Text-only: model is done. Close the AgentRound, commit ChatRound.
          const agent = agentRound(this.state.agentChildren)
          this._commit(agent)

          // Since userSpans is now [], this accurately commits just the model's final response
          const chat = chatRound(this.state.userSpans, content ?? '', think)
          this._commit(chat)
          this.state = { kind: 'idle' }

          return
        }

        // More calls: transition to awaiting_results for the next ToolRound.
        this.state = {
          kind: 'awaiting_results',
          userSpans: this.state.userSpans,
          agentChildren: this.state.agentChildren,
          pendingCalls: calls,
          pendingThink: think,
          pendingContent: content,
        }

        return
      }

      // -- awaiting_results: model called again before results arrived ---
      case 'awaiting_results': {
        // FSM violation: strict call->result pairing required.
        consola.error('[FSM] model called again before results arrived - emitting ErrorRound')

        const err = errorRound(
          'FSM violation: model produced new output before tool results were received.',
          content,
        )
        this.state = {
          ...this.state,
          agentChildren: [...this.state.agentChildren, err],
        }

        return
      }

      // -- idle: headless run() - no user turn ---
      case 'idle': {
        if (!hasCalls) {
          // Headless text-only response - emit a bare chat round with no user content
          const round = chatRound([], content ?? '', think)
          this._commit(round)

          return
        }

        // Headless with calls: open agent with empty userSpans
        this.state = {
          kind: 'awaiting_results',
          userSpans: [],
          agentChildren: [],
          pendingCalls: calls,
          pendingThink: think,
          pendingContent: content,
        }

        return
      }
    }
  }

  /**
   * Tool results arrived for the pending calls.
   * Must be called once per tool batch (all results for the current model turn).
   */
  onResults(results: StoredToolResult[]): void {
    if (this.state.kind !== 'awaiting_results') {
      consola.error(`[FSM] onResults in unexpected state=${this.state.kind}`)

      return
    }

    const tool = toolRound(
      this.state.pendingCalls,
      results,
      this.state.pendingThink,
      this.state.pendingContent,
    )

    this.state = {
      kind: 'in_agent',
      userSpans: this.state.userSpans,
      agentChildren: [...this.state.agentChildren, tool],
    }
  }

  /**
   * An error occurred (parse failure, malformed call, FSM violation).
   * Emits an ErrorRound into the current agent run so the model sees the mistake.
   */
  onError(message: string, input?: string): void {
    const err = errorRound(message, input)

    if (this.state.kind === 'in_agent' || this.state.kind === 'awaiting_results') {
      const children =
        this.state.kind === 'in_agent'
          ? this.state.agentChildren
          : this.state.agentChildren  // same field in both

      this.state = {
        ...this.state,
        agentChildren: [...children, err],
      } as typeof this.state

      return
    }

    // Outside an agent run: commit as a standalone system-level error
    this._commit(err)
  }

  /**
   * Orchestrator injected a system message (think-only correction, mode switch, etc).
   */
  onSystem(message: string): void {
    const sys = systemRound(message)

    if (this.state.kind === 'in_agent' || this.state.kind === 'awaiting_results') {
      const children =
        this.state.kind === 'in_agent'
          ? this.state.agentChildren
          : this.state.agentChildren

      this.state = {
        ...this.state,
        agentChildren: [...children, sys],
      } as typeof this.state

      return
    }

    this._commit(sys)
  }

  /**
   * Explicit done signal (model called the `done` tool).
   * Closes the agent run with the last committed ToolRound as the final result.
   * The `result` string becomes the ChatRound model text.
   */
  onDone(result?: string): void {
    if (this.state.kind === 'in_agent' || this.state.kind === 'awaiting_results') {
      const agent = agentRound(this.state.agentChildren)
      this._commit(agent)

      // Emit ChatRound with done result as model response
      const chat = chatRound(this.state.userSpans, result ?? '', undefined)
      this._commit(chat)
      this.state = { kind: 'idle' }

      return
    }

    consola.warn(`[FSM] onDone in unexpected state=${this.state.kind}`)
  }

  /**
   * Session ended without a clean done (turn limit, abort, ejection).
   * Forces the open agent run closed using whatever was last committed.
   * AgentRound fallback policy: last child's result is always the summary.
   */
  onAbort(): void {
    this._forceClose()
  }

  // --- Internals ---

  private _commit(round: Round): void {
    // Stamp count from span chars if not already set by Pass 1
    if (round.count === 0) {
      round.count = countSpanChars(round.spans({ age: 0, memory: new Map(), budget: Infinity }))
    }
    this.history.push(round)

    consola.debug(`[FSM] committed ${round.id} - history.length=${this.history.length}`)
  }

  private _forceClose(): void {
    if (this.state.kind === 'idle') return

    if (this.state.kind === 'awaiting_model') {
      // User message with no model response - commit as chat round with empty model text
      this._commit(chatRound(this.state.userSpans, ''))
      this.state = { kind: 'idle' }

      return
    }

    // Close any open agent run
    if (this.state.kind === 'in_agent' || this.state.kind === 'awaiting_results') {
      const agent = agentRound(this.state.agentChildren)
      this._commit(agent)
    }

    this.state = { kind: 'idle' }
  }
}
