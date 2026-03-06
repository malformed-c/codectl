/**
 * Extension lifecycle protocols.
 *
 * Ported from yodoca/core/extensions/contract.py.
 *
 * Extensions are self-contained units that plug into the orchestrator via
 * typed capability interfaces. The loader detects capabilities with
 * `instanceof` checks rather than explicit type fields, so an extension
 * can implement multiple capabilities by implementing multiple interfaces.
 *
 * Lifecycle order: initialize → start → (running) → stop → destroy
 */

import type { ToolDefinition, ToolResult } from '../tool'
import type { EventBus } from '../events/bus'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export enum ExtensionState {
  INACTIVE = 'inactive',
  ACTIVE   = 'active',
  ERROR    = 'error',
}

// ---------------------------------------------------------------------------
// Context injected into every extension at initialize() time
// ---------------------------------------------------------------------------

export type ExtensionContext = {
  /** Extension's own manifest id. */
  id: string
  /** Shared event bus for cross-extension communication. */
  bus: EventBus
  /** Resolve a secret by name (env var or secrets store). */
  getSecret: (name: string) => string | undefined
  /** Access arbitrary shared settings. */
  getSetting: <T = unknown>(key: string, fallback?: T) => T
}

// ---------------------------------------------------------------------------
// Base lifecycle contract
// ---------------------------------------------------------------------------

export interface Extension {
  /** Called once on load. Subscribe to bus topics, open connections. */
  initialize(context: ExtensionContext): Promise<void>
  /** Start active work: polling loops, HTTP servers, background tasks. */
  start(): Promise<void>
  /** Graceful shutdown. Cancel tasks, flush buffers, close connections. */
  stop(): Promise<void>
  /** Release all resources. Called after stop(). */
  destroy(): Promise<void>
  /** true = operating normally. */
  healthCheck(): boolean
}

// ---------------------------------------------------------------------------
// Capability protocols
// ---------------------------------------------------------------------------

/**
 * ToolProvider: contributes callable tools to the orchestrator.
 *
 * Handlers are registered separately via registerTool() - this interface
 * just exposes the definitions so the loader can wire them automatically.
 */
export interface ToolProvider {
  /** ToolDefinition list + paired handler map keyed by tool name. */
  getTools(): Array<{ definition: ToolDefinition; handler: (args: Record<string, unknown>) => Promise<ToolResult> }>
}

/**
 * ChannelProvider: user-facing communication channel.
 *
 * Implement this for Telegram, Slack, CLI, etc.
 * The loader will wire message events from the bus to onMessage().
 */
export interface ChannelProvider {
  /** Reply to a specific user (reactive). */
  sendToUser(userId: string, message: string): Promise<void>
  /** Proactive message to the channel's default recipient. */
  sendMessage(message: string): Promise<void>
}

/** Channels that support incremental streaming delivery. */
export interface StreamingChannelProvider extends ChannelProvider {
  onStreamStart(userId: string): Promise<void>
  onStreamChunk(userId: string, chunk: string): Promise<void>
  onStreamStatus(userId: string, status: string): Promise<void>
  onStreamEnd(userId: string, fullText: string): Promise<void>
}

/**
 * ContextProvider: enriches the system prompt before each agent turn.
 *
 * Multiple ContextProviders coexist; the loader calls them in ascending
 * priority order and concatenates non-empty results.
 */
export interface ContextProvider {
  /** Lower = earlier in the chain. Default 100. */
  readonly contextPriority: number
  /**
   * Return a string to prepend to the system context, or null/undefined to skip.
   * Called before every Runner.run() / Orchestrator.chat().
   */
  getContext(prompt: string, turnContext: TurnContext): Promise<string | null | undefined>
}

export type TurnContext = {
  agentId?: string
  channelId?: string
  userId?: string
  sessionId?: string
}

/**
 * SetupProvider: extensions that need interactive configuration.
 *
 * The onboarding wizard calls getSetupSchema() to collect credentials,
 * then calls applyConfig() for each, then onSetupComplete() to verify.
 */
export interface SetupProvider {
  getSetupSchema(): SetupParam[]
  applyConfig(name: string, value: string): Promise<void>
  onSetupComplete(): Promise<[ok: boolean, message: string]>
}

export type SetupParam = {
  name: string
  description: string
  secret: boolean
  required: boolean
}

/**
 * AgentProvider: extension that exposes a specialized sub-agent.
 *
 * The orchestrator can delegate tasks to agent providers either as a tool
 * call (tool mode) or as a handoff (handoff mode, transfers full context).
 */
export interface AgentProvider {
  getAgentDescriptor(): AgentDescriptor
  invoke(task: string, context?: AgentInvocationContext): Promise<AgentResponse>
}

export type AgentDescriptor = {
  name: string
  description: string
  integrationMode: 'tool' | 'handoff'
}

export type AgentInvocationContext = {
  conversationSummary?: string
  userMessage?: string
  correlationId?: string
}

export type AgentResponse = {
  status: 'success' | 'error' | 'refused'
  content: string
  error?: string
  tokensUsed?: number
  turnsUsed?: number
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isToolProvider(ext: unknown): ext is ToolProvider {
  return typeof ext === 'object' && ext !== null && typeof (ext as ToolProvider).getTools === 'function'
}

export function isChannelProvider(ext: unknown): ext is ChannelProvider {
  return typeof ext === 'object' && ext !== null &&
    typeof (ext as ChannelProvider).sendToUser === 'function' &&
    typeof (ext as ChannelProvider).sendMessage === 'function'
}

export function isStreamingChannelProvider(ext: unknown): ext is StreamingChannelProvider {
  return isChannelProvider(ext) &&
    typeof (ext as StreamingChannelProvider).onStreamStart === 'function'
}

export function isContextProvider(ext: unknown): ext is ContextProvider {
  return typeof ext === 'object' && ext !== null &&
    typeof (ext as ContextProvider).getContext === 'function'
}

export function isAgentProvider(ext: unknown): ext is AgentProvider {
  return typeof ext === 'object' && ext !== null &&
    typeof (ext as AgentProvider).getAgentDescriptor === 'function' &&
    typeof (ext as AgentProvider).invoke === 'function'
}

export function isSetupProvider(ext: unknown): ext is SetupProvider {
  return typeof ext === 'object' && ext !== null &&
    typeof (ext as SetupProvider).getSetupSchema === 'function'
}
