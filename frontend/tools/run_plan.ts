import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { KoboldAdapter } from '../kobold'
import { runPlan } from '../plan_runner'
import type { CodePlan } from '../codeplan.schema'
import { codePlanSchema } from '../codeplan.schema'

export const RunPlanTool: ToolDefinition = {
  name: 'run_plan',
  description:
    'Execute a validated CodePlan. Resolves stream IDs, dry-applies all Codeq ops, ' +
    'checks for file conflicts, then writes CodeEdit changes and runs Ansible tasks. ' +
    'Only call after validate_plan has returned valid=true. Only available in codeplan mode.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: 'The validated CodePlan JSON to execute.',
        aliases: ['json', 'codeplan'],
      },
    },
    required: ['plan'],
  },
  returns: {
    type: 'object',
    properties: {
      ok:              { type: 'boolean', description: 'Whether all phases succeeded.' },
      failedPhase:     { type: 'string',  description: 'Phase that failed (if ok=false).' },
      dryApplyErrors:  { type: 'string',  description: 'Codeq errors found during dry apply.' },
      conflictedFiles: { type: 'string',  description: 'Files modified externally since plan started.' },
      written:         { type: 'string',  description: 'Files written by CodeEdit phase.' },
      ansibleReport:   { type: 'string',  description: 'Structured Ansible execution report.' },
      error:           { type: 'string',  description: 'Top-level error message.' },
    },
  },
}

export function createRunPlanHandler(
  getGitRoot: () => string,
  getBackendDir: () => string,
  adapter: KoboldAdapter,
): ToolHandler {
  return async (args) => {
    const raw = args.plan ?? args.json ?? args.codeplan ?? args.value
    if (!raw) return { result: null, error: "'plan' argument is required" }

    const validated = codePlanSchema.safeParse(raw)
    if (!validated.success) {
      const errors = validated.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)

      return { result: null, error: `Plan failed schema validation:\n${errors.join('\n')}` }
    }

    const plan = validated.data as CodePlan
    const gitRoot = getGitRoot()
    const backendDir = getBackendDir()

    if (!gitRoot) return { result: null, error: 'run_plan requires a git root (switch to codeplan mode first)' }

    const result = await runPlan(plan, { adapter, gitRoot, backendDir })

    if (!result.ok) {
      // Format a clear error report for the model to reason about
      const parts: string[] = [`Plan execution failed at phase: ${result.failedPhase}`]

      if (result.dryApplyErrors?.length) {
        parts.push('Dry apply errors:')
        for (const e of result.dryApplyErrors) {
          parts.push(`  ${e.resource} / ${e.operation}: ${e.error}`)
        }
      }

      if (result.conflictedFiles?.length) {
        parts.push(`Files modified externally: ${result.conflictedFiles.join(', ')}`)
      }

      if (result.ansibleReport && !result.ansibleReport.ok) {
        parts.push('Ansible failures:')
        for (const r of result.ansibleReport.results) {
          if (r.status === 'failed' || r.status === 'unreachable') {
            parts.push(`  [${r.status}] ${r.name}: ${r.message}`)
          }
        }
      }

      if (result.error) parts.push(`Error: ${result.error}`)

      return { result: null, error: parts.join('\n') }
    }

    return {
      result: {
        ok: true,
        written: result.written ?? [],
        ansibleReport: result.ansibleReport ?? null,
      },
    }
  }
}
