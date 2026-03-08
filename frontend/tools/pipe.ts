import type { ToolDefinition, ToolResult, ToolHandler } from '../orchestrator'
import { ok, err } from '../tool'
import consola from 'consola'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipeStep = {
  tool: string
  args: Record<string, unknown>
  /** Optional name for this step's output. Stored as $name in addition to $_N. */
  as?: string
}

/**
 * Execute a single tool call.  Matches the signature of Orchestrator.executeToolCall
 * (exposed via the factory parameter).
 */
export type ExecuteFn = (name: string, args: Record<string, unknown>) => Promise<ToolResult>

// ---------------------------------------------------------------------------
// Result → string helpers
// ---------------------------------------------------------------------------

/**
 * Extract the "main" string value from a tool result for $-substitution.
 *
 * Priority:
 *   1. result.value is a string → use as-is
 *   2. result.value has a `stdout` field → use stdout (bash-style)
 *   3. result.value has an `output` field → use output
 *   4. fallback → JSON.stringify
 */
function mainValue(result: ToolResult): string {
  if (!result.ok) return ''
  const v = result.value
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    if (typeof obj.stdout === 'string') return obj.stdout
    if (typeof obj.output === 'string') return obj.output
  }
  return JSON.stringify(v)
}

/**
 * Build a flat map of substitution variables for a completed step.
 *
 *   $_N        → main string value (stdout / string / JSON)
 *   $_N.field  → individual fields of an object result
 *   $_prev     → same as $_N (always points to the last step)
 *   $name      → same as $_N when step.as is set
 *   $name.field
 */
function stepVars(result: ToolResult, index: number, as?: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const main = mainValue(result)
  const nKey = `_${index}`

  vars[nKey] = main
  vars['_prev'] = main
  if (as) vars[as] = main

  if (result.ok && result.value && typeof result.value === 'object') {
    const obj = result.value as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      const fieldStr = typeof v === 'string' ? v : JSON.stringify(v)
      vars[`${nKey}.${k}`] = fieldStr
      if (as) vars[`${as}.${k}`] = fieldStr
    }
  }

  return vars
}

/**
 * Interpolate $key / ${key} references from `scope` into all string values
 * of `args`.  Non-string values are left untouched.
 */
function interpolate(
  args: Record<string, unknown>,
  scope: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string') { out[k] = v; continue }
    out[k] = v.replace(/\$\{([^}]+)\}|\$([\w.]+)/g, (_m, braced, bare) => {
      const key = braced ?? bare
      return key in scope ? scope[key]! : _m
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const PipeTool: ToolDefinition = {
  name: 'pipe',
  description:
    'Execute a sequence of tool calls where each step\'s output is available ' +
    'to subsequent steps via $-substitution. ' +
    'Reference the previous step\'s result with $_prev, or a specific step with ' +
    '$_0, $_1, etc. For object results (e.g. bash) use field access: ' +
    '$_0.stdout, $_0.exitCode. ' +
    'Set "as" on a step to give its output a readable name: $name or $name.stdout. ' +
    'Stops on first error unless continue_on_error is true.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered list of tool calls to execute.',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name.' },
            args: { type: 'object', description: 'Arguments for the tool. May contain $-references.' },
            as:   { type: 'string', description: 'Name this step\'s output for use in later steps.' },
          },
          required: ['tool'],
        },
      },
      continue_on_error: {
        type: 'boolean',
        description: 'If true, continue executing remaining steps even when one fails.',
      },
    },
    required: ['steps'],
  },
  returns: {
    type: 'object',
    properties: {
      results:   { type: 'array',   description: 'Per-step results.' },
      final:     { type: 'object',  description: 'Last step\'s result value.' },
      failed_at: { type: 'number',  description: 'Index of the first failed step, if any.' },
    },
  },
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createPipeHandler(execute: ExecuteFn): ToolHandler {
  return async (args) => {
    const steps = args.steps as PipeStep[]
    if (!Array.isArray(steps) || steps.length === 0) {
      return err("'steps' must be a non-empty array")
    }

    const continueOnError = Boolean(args.continue_on_error)
    const scope: Record<string, string> = {}

    type StepRecord = {
      tool: string
      ok: boolean
      value?: unknown
      error?: string
    }

    const results: StepRecord[] = []
    let failedAt: number | undefined

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      if (!step.tool) {
        return err(`Step ${i}: missing 'tool'`)
      }

      // Interpolate $-refs from previous step outputs into this step's args
      const rawArgs = (step.args ?? {}) as Record<string, unknown>
      const resolvedArgs = interpolate(rawArgs, scope)

      consola.debug(`[pipe] step ${i}: ${step.tool}`, resolvedArgs)

      const result = await execute(step.tool, resolvedArgs)

      const record: StepRecord = { tool: step.tool, ok: result.ok }
      if (result.ok) {
        record.value = result.value
      } else {
        record.error = result.error
      }
      results.push(record)

      if (result.ok) {
        // Merge this step's variables into scope for subsequent steps
        Object.assign(scope, stepVars(result, i, step.as))
      } else {
        failedAt = i
        consola.warn(`[pipe] step ${i} (${step.tool}) failed: ${result.error}`)
        if (!continueOnError) break
      }
    }

    const lastResult = results.at(-1)
    const finalValue = lastResult?.ok ? lastResult.value : undefined

    return ok({
      results,
      final: finalValue,
      ...(failedAt !== undefined ? { failed_at: failedAt } : {}),
    })
  }
}
