import consola from 'consola'
import {
  agentRound,
  chatRound,
  errorRound,
  systemRound,
  toolRound,
  type History,
  type Round,
} from './round'
import type { Span } from './span'
import { countSpanChars } from './span'
import type { StoredToolCall, StoredToolResult } from './types'

// --- FSM States ---
//
// Three states.
//
// Key invariant: userSpans (the triggering message) NEVER leave the state object
// until they are committed inside a Round. This prevents the "orphan bug" where
// user messages were committed as empty ChatRounds before the agent run began.

/** No active conversation. */
type StateIdle = { kind: 'idle' }

/**
 * User message received. Waiting for the first model response.
 * If the model responds with text only -> commit ChatRound -> idle.
 * If the model makes tool calls -> transition to agent (trigger = userSpans).
 */
type StateChat = {
  kind: 'chat'
  userSpans: Span[]
}

/**
 * Inside a tool-using run. Entered from chat when the model first calls a tool,
 * OR headlessly from idle when the orchestrator calls run().
 *
 * `trigger` is the original user message that started this run. It stays here
 * until the run completes and is baked into the AgentRound.
 *
 * `pending` is set between onModel(calls) and onResults(). While set, the FSM
 * will reject another onModel() call as a protocol violation.
 */
type StateAgent = {
  kind: 'agent'
  trigger: Span[]
  children: Round[]
  pending?: {
    calls: StoredToolCall[]
    think?: string
    content?: string
  }
}

type FsmState = StateIdle | StateChat | StateAgent

// --- Fsm ---

/**
 * Incremental FSM that builds the conversation history tree.
 *
 * Two round types:
 *   ChatRound  - simple text exchange, no tools
 *   AgentRound - any exchange involving tools; owns its trigger + tool loop + response
 *
 * Invalid transitions produce ErrorRounds rather than silently corrupting state.
 * The cursor field always equals history.length - used by CheckpointStore.
 */
export class Fsm {
  readonly history: History = []
  private state: FsmState = { kind: 'idle' }

  /** Index of the next uncommitted round. Used by CheckpointStore.save(). */
  get cursor(): number { return this.history.length }

  /**
   * Returns the full history including the in-progress round that is currently
   * being built. Used by the orchestrator to render the prompt for the next turn.
   */
  getRenderableHistory(): Round[] {
    const history = [...this.history]

    switch (this.state.kind) {
      case 'chat':
        // Pending user turn: show as an empty-response chat round
        history.push(chatRound(this.state.userSpans, ''))
        break

      case 'agent': {
        // Build the in-progress agent round with whatever we have so far
        const pendingChildren = this.state.pending
          ? [...this.state.children, toolRound(this.state.pending.calls, [], this.state.pending.think, this.state.pending.content)]
          : this.state.children

        history.push(agentRound(this.state.trigger, pendingChildren))
        break
      }
    }

    return history
  }

  // --- Events ---

  /**
   * User sent a message. Must be called before the orchestrator loop.
   * For headless run() with no user turn, skip directly to onModel.
   */
  onUser(userSpans: Span[]): void {
    if (this.state.kind === 'chat') {
      // Model hasn't responded yet - append to the existing user turn
      if (userSpans.length > 0) {
        this.state.userSpans.push({ kind: 'content', text: '\n' })
        this.state.userSpans.push(...userSpans)
      }

      return
    }

    if (this.state.kind !== 'idle') {
      // User interrupted an in-progress agent run - force-close then accept
      consola.warn(`[FSM] onUser in state=${this.state.kind}, force-closing`)

      this._forceClose()
    }

    this.state = { kind: 'chat', userSpans }
  }

  /**
   * Model produced a response (think + content + optional tool calls).
   * Called once per adapter.generate() invocation.
   *
   * Transitions:
   *   chat  + no calls -> commit ChatRound -> idle
   *   chat  + calls    -> agent (trigger = userSpans, pending = calls)
   *   agent + no calls -> commit AgentRound (with response) -> idle
   *   agent + calls    -> agent (pending = calls)
   *   agent + pending  -> FSM violation ErrorRound (results not yet received)
   *   idle  + no calls -> commit headless ChatRound -> idle
   *   idle  + calls    -> agent (trigger = [], pending = calls)
   */
  onModel(think: string | undefined, content: string | undefined, calls: StoredToolCall[]): void {
    const hasCalls = calls.length > 0

    switch (this.state.kind) {

      case 'chat': {
        if (!hasCalls) {
          // Simple exchange: commit and return to idle
          this._commit(chatRound(this.state.userSpans, content ?? '', think))
          this.state = { kind: 'idle' }

          return
        }

        // Tool calls: transition to agent, carrying the user message as trigger.
        // The user message is NOT committed separately here - it travels with the
        // AgentRound and will be committed when the run completes.
        this.state = {
          kind: 'agent',
          trigger: this.state.userSpans,
          children: [],
          pending: { calls, think, content },
        }

        return
      }

      case 'agent': {
        if (this.state.pending) {
          // FSM violation: model produced output before results arrived
          consola.error('[FSM] onModel called while results still pending - emitting ErrorRound')

          const err = errorRound(
            'FSM violation: model produced new output before tool results were received.',
            content,
          )
          this.state = { ...this.state, children: [...this.state.children, err] }

          return
        }

        if (!hasCalls) {
          // Agent run complete: commit the full AgentRound with final response
          this._commit(agentRound(this.state.trigger, this.state.children, content, think))
          this.state = { kind: 'idle' }

          return
        }

        // More tool calls: set pending, stay in agent
        this.state = { ...this.state, pending: { calls, think, content } }

        return
      }

      case 'idle': {
        if (!hasCalls) {
          // Headless text-only response (no prior user turn)
          this._commit(chatRound([], content ?? '', think))

          return
        }

        // Headless with tool calls: open agent with empty trigger
        this.state = {
          kind: 'agent',
          trigger: [],
          children: [],
          pending: { calls, think, content },
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
    if (this.state.kind !== 'agent' || !this.state.pending) {
      consola.error(`[FSM] onResults called but no pending tool calls (state=${this.state.kind})`)

      return
    }

    const { calls, think, content } = this.state.pending
    const tool = toolRound(calls, results, think, content)

    this.state = {
      ...this.state,
      children: [...this.state.children, tool],
      pending: undefined,
    }
  }

  /**
   * An error occurred (parse failure, malformed call, FSM violation).
   * Appended to current agent children, or committed directly if outside an agent run.
   */
  onError(message: string, input?: string): void {
    this._appendOrCommit(errorRound(message, input))
  }

  /**
   * Orchestrator injected a system message (think-only correction, etc).
   * Appended to current agent children, or committed directly if outside an agent run.
   */
  onSystem(message: string): void {
    this._appendOrCommit(systemRound(message))
  }

  /**
   * Explicit done signal (model called the `done` tool).
   * Commits the AgentRound with the done result as the final response.
   */
  onDone(result?: string): void {
    if (this.state.kind === 'agent') {
      this._commit(agentRound(this.state.trigger, this.state.children, result ?? ''))
      this.state = { kind: 'idle' }

      return
    }

    consola.warn(`[FSM] onDone in unexpected state=${this.state.kind}`)
  }

  /**
   * Session ended without a clean done (turn limit, abort, ejection).
   * Forces any open run closed using whatever was last accumulated.
   */
  onAbort(): void {
    this._forceClose()
  }

  /**
   * Hydrate history from deserialized rounds (e.g. checkpoint restore).
   * Bypasses the normal event flow - rounds are stamped and appended directly.
   * FSM stays in idle after hydration; session is treated as fully committed.
   */
  hydrate(rounds: Round[]): void {
    for (const round of rounds) {
      this._commit(round)
    }
  }

  // --- Internals ---

  private _commit(round: Round): void {
    if (round.count === 0) {
      round.count = countSpanChars(round.spans({ age: 0, memory: new Map(), budget: Infinity }))
    }

    this.history.push(round)
    consola.debug(`[FSM] committed ${round.id} (${round.serialize().kind}) - history=${this.history.length}`)
  }

  /**
   * Append a round to current agent children if inside an agent run,
   * or commit it directly to history if outside one.
   */
  private _appendOrCommit(round: Round): void {
    if (this.state.kind === 'agent') {
      this.state = { ...this.state, children: [...this.state.children, round] }

      return
    }

    this._commit(round)
  }

  private _forceClose(): void {
    switch (this.state.kind) {
      case 'idle':
        return

      case 'chat':
        // User message with no model response
        this._commit(chatRound(this.state.userSpans, ''))
        break

      case 'agent': {
        const children = this.state.pending
          ? [
            ...this.state.children,
            errorRound(`Agent aborted: ${this.state.pending.calls.length} tool call(s) dispatched but results never arrived.`),
          ]
          : this.state.children

        this._commit(agentRound(this.state.trigger, children))
        break
      }
    }

    this.state = { kind: 'idle' }
  }
}
