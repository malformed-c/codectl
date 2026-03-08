import type { ToolDefinition } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { CodePlan } from '../codeplan.schema'
import { codePlanSchema } from '../codeplan.schema'
import destr from 'destr'

// --- Types ---

/**
 * Invoked by the handler after a successful or failed validation.
 * The orchestrator uses this to update its planValidationState and
 * rebuild the system prompt so the model always knows the latest status.
 *
 * On success: lastPlan is the parsed CodePlan, errors is [].
 * On failure: lastPlan is undefined, errors contains the schema violations.
 */
export type PlanValidationCallback = (lastPlan: CodePlan | undefined, errors: string[]) => void

// --- Tool definition ---

/**
 * Validate a CodePlan JSON object against the schema before running it.
 * Returns { valid: true } on success or { valid: false, errors } with schema violations.
 *
 * The handler calls PlanValidationCallback so the orchestrator can update its
 * system prompt with the latest validation status (injected via rebuildSystemMessage).
 */
export const ValidatePlanTool: ToolDefinition = {
  name: 'validate_plan',
  description:
    'Validate a CodePlan JSON object against the schema. ' +
    'Returns { valid: true } on success or { valid: false, errors } with schema violations.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: 'The CodePlan JSON to validate.',
        aliases: ['json', 'codeplan', 'codePlan', 'value'],
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

// --- Handler ---

export function createValidatePlanHandler(onValidated: PlanValidationCallback): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const raw = args.plan ?? args.json ?? args.codeplan ?? args.value
    if (!raw) return err("'plan' argument is required")

    // Parse: try JSON.parse first (throws on failure), fall back to destr
    // (returns input unchanged on failure - so check after).
    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch {
        parsed = destr(raw)
        // destr returns the original string on failure — treat as parse error
        if (typeof parsed === 'string') return err(`Invalid JSON: could not parse plan string`)
      }
    }

    // Auto-unwrap common LLM mistakes. Apply recursively: a string value inside
    // a wrapper object should itself be parsed as JSON before unwrapping.
    function maybeParseString(v: unknown): unknown {
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    }

    function unwrap(v: unknown): unknown {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v
      const o = v as Record<string, unknown>
      // Already correct shape
      if (o.codePlan) return v
      // Nested under .plan
      if (o.plan) return unwrap(maybeParseString(o.plan))
      // Nested under .value
      if (o.value) return unwrap(maybeParseString(o.value))
      return v
    }

    const unwrapped = unwrap(parsed)
    const normalized = Array.isArray(unwrapped) ? { codePlan: unwrapped } : unwrapped

    try {
      const result = codePlanSchema.safeParse(normalized)

      if (result.success) {
        onValidated(result.data, [])
        return ok({ valid: true, message: 'CodePlan is valid and ready for execution.'})
      }

      const issues = result.error?.issues ?? []
      const errors: string[] = issues.length
        ? issues.map((e: any) => `${(e.path ?? []).join('.') || '(root)'}: ${e.message}`)
        : [`Validation failed: ${JSON.stringify(result.error)}`]

      onValidated(undefined, errors)
      return ok({ valid: false, errors})

    } catch (e) {
      return err(`Schema validation failed: ${e}`)
    }
  }
}
