/**
 * A structured tool call entry stored in history.
 * The `tool` field is the tool name; all other fields are arguments.
 */
export type StoredToolCall = {
  tool: string
  callId?: string
  [key: string]: unknown
}

/**
 * A structured tool result stored in history.
 * Holds the raw result value so it is only serialized once at render time,
 * preventing double-escaping when result is already a string.
 */
export type StoredToolResult = {
  callId?: string
  error?: string
  value?: unknown
}
