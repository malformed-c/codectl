import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { LLMAdapter } from '../orchestrator'
import { runPlan } from '../plan_runner'
import type { CodePlan } from '../codeplan.schema'
import { codePlanSchema } from '../codeplan.schema'
import type { PlanRunResult } from '../plan_runner'
import destr from 'destr'

export const RunPlanTool: ToolDefinition = {
  name: 'run_plan',
  description:
    'Execute a validated CodePlan. Resolves stream IDs, dry-applies all Codeq ops, ' +
    'checks for file conflicts, then writes CodeEdit changes and runs Ansible tasks. ' +
    'Only call after validate_plan has returned valid=true.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: 'The validated CodePlan JSON object or memory key to execute.',
        aliases: ['json', 'codeplan', 'codePlan', 'value'],
      },
    },
    required: ['plan'],
  },
  returns: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether all phases succeeded.' },
      failedPhase: { type: 'string', description: 'Phase that failed (if ok=false).' },
      dryApplyErrors: { type: 'string', description: 'Codeq errors found during dry apply.' },
      conflictedFiles: { type: 'string', description: 'Files modified externally since plan started.' },
      written: { type: 'string', description: 'Files written by CodeEdit phase.' },
      ansibleReport: { type: 'string', description: 'Structured Ansible execution report.' },
      error: { type: 'string', description: 'Top-level error message.' },
    },
  },
}

export function createRunPlanHandler(
  getGitRoot: () => string,
  getBackendDir: () => string,
  adapter: LLMAdapter,
): ToolHandler {
  return async (args) => {
    const raw = args.plan ?? args.json ?? args.codeplan ?? args.value
    if (!raw) return { result: null, error: "'plan' argument is required" }

    let parsed: unknown
    try {
      parsed = typeof raw === 'string' ? destr(raw as string) : raw

    } catch (err) {
      return { result: null, error: `Invalid JSON: ${err}` }
    }

    // auto-unwrap common LLM mistake
    const normalized =
      parsed?.codePlan ? parsed :
        parsed?.plan?.codePlan ? parsed.plan :
          parsed?.value?.codePlan ? parsed.value :
            parsed

    const validated = codePlanSchema.safeParse(normalized)
    if (!validated.success) {
      const issues = validated.error.issues ?? []
      const errors = issues.map(e => `${e.path.join('.')}: ${e.message}`)

      return { result: null, error: `Plan failed schema validation:\n${errors.join('\n')}` }
    }

    const plan = validated.data as CodePlan
    const gitRoot = getGitRoot()
    const backendDir = getBackendDir()

    // TODO make a git root tool
    // Git root comes from agent mode (set when the model calls mode[ARGS]{"mode":"agent"}).
    // run_plan requires it because Ansible playbooks need a concrete working directory.
    if (!gitRoot) return { result: null, error: 'run_plan requires a git root (switch to agent mode first)' }

    const result = await runPlan(plan, { adapter, gitRoot, backendDir })

    if (!result.ok) {
      return { result: null, error: formatRunPlanFailure(result) }
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

export function formatRunPlanFailure(result: PlanRunResult): string {
  // Format a clear error report for the model to reason about
  const parts: string[] = [`Plan execution failed at phase: ${result.failedPhase}`]
  let hasConcreteReason = false

  if (result.dryApplyErrors?.length) {
    hasConcreteReason = true

    parts.push('Dry apply errors:')
    for (const e of result.dryApplyErrors) {
      parts.push(`  ${e.resource} / ${e.operation}: ${e.error}`)
    }
  }

  if (result.conflictedFiles?.length) {
    hasConcreteReason = true

    parts.push(`Files modified externally: ${result.conflictedFiles.join(', ')}`)
  }

  if (result.ansibleReport && !result.ansibleReport.ok) {
    parts.push('Ansible failures:')

    let hasTaskFailures = false
    for (const r of result.ansibleReport.results) {
      if (r.status === 'failed' || r.status === 'unreachable') {
        hasTaskFailures = true
        hasConcreteReason = true

        parts.push(`  [${r.status}] ${r.name}: ${r.message}`)
      }
    }

    if (result.ansibleReport.error) {
      hasConcreteReason = true

      parts.push(`  Backend error: ${result.ansibleReport.error}`)

    } else if (!hasTaskFailures) {
      parts.push('  Backend error: unknown ansible failure')

      hasConcreteReason = true
    }
  }

  if (result.error) {
    hasConcreteReason = true
    parts.push(`Error: ${result.error}`)
  }

  if (!hasConcreteReason) {
    parts.push('Error: unknown execution failure')
  }

  return parts.join('\n')
}
