import { describe, expect, test } from 'bun:test'
import { createRunPlanHandler, formatRunPlanFailure } from '../tools/run_plan'
import type { PlanRunResult } from '../plan_runner'

function baseFailureResult(): PlanRunResult {
  return {
    ok: false,
    failedPhase: 'execute',
  }
}

describe('formatRunPlanFailure', () => {
  test('includes backend error when ansible fails with empty task results', () => {
    const error = formatRunPlanFailure({
      ...baseFailureResult(),
      ansibleReport: {
        ok: false,
        results: [],
        error: 'playbook crashed before task output',
      },
    })

    expect(error).toContain('Ansible failures:')
    expect(error).toContain('Backend error: playbook crashed before task output')
  })

  test('includes failed ansible task lines', () => {
    const error = formatRunPlanFailure({
      ...baseFailureResult(),
      ansibleReport: {
        ok: false,
        results: [
          { name: 'Install deps', status: 'failed', message: 'apt lock held' },
          { name: 'Reach host', status: 'unreachable', message: 'ssh timeout' },
        ],
      },
    })

    expect(error).toContain('[failed] Install deps: apt lock held')
    expect(error).toContain('[unreachable] Reach host: ssh timeout')
    expect(error).not.toContain('Backend error:')
  })

  test('includes both task failures and top-level backend error', () => {
    const error = formatRunPlanFailure({
      ...baseFailureResult(),
      ansibleReport: {
        ok: false,
        results: [
          { name: 'Restart service', status: 'failed', message: 'unit failed' },
        ],
        error: 'ansible-runner exited with code 2',
      },
    })

    expect(error).toContain('[failed] Restart service: unit failed')
    expect(error).toContain('Backend error: ansible-runner exited with code 2')
    expect(error.indexOf('[failed] Restart service: unit failed')).toBeLessThan(
      error.indexOf('Backend error: ansible-runner exited with code 2'),
    )
  })
})

describe('createRunPlanHandler', () => {
  test('returns schema errors instead of throwing when plan is invalid', async () => {
    const handler = createRunPlanHandler(
      () => '/repo',
      () => '/repo/backend',
      {} as any,
    )

    const result = await handler({ plan: { notAPlan: true } })

    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toContain('Plan failed schema validation:')
  })
})

describe('createRunPlanHandler success path', () => {
  test('returns err when gitRoot is unavailable (no bare object thrown)', async () => {
    // Regression: run_plan used to return { result: { ok: true, ... } } bare object
    // instead of ok(...). Verify the handler always returns a ToolResult shape.
    const handler = createRunPlanHandler(
      () => '',   // empty gitRoot -> triggers err('run_plan requires a git root')
      () => '',
      {} as any,
    )

    const validPlan = {
      plan: {
        codePlan: [{
          apiVersion: 'codectl/v1',
          kind: 'Ansible',
          metadata: { description: 'test', order: 1 },
          spec: { hosts: 'localhost', tasks: [{ name: 'ping', module: 'ping', args: {} }] },
        }],
      },
    }

    const result = await handler(validPlan)

    // Must be a proper ToolResult, not a bare object
    expect('ok' in result).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('git root')
    }
  })
})
