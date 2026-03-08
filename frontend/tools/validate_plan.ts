import type { ToolDefinition } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { CodePlan } from '../codeplan.schema'
import { codePlanSchema } from '../codeplan.schema'
import { parsePlan } from './plan_parse'

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

    const planResult = parsePlan(raw)
    if (!planResult.ok) return err(planResult.error)
    const normalized = planResult.value

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
