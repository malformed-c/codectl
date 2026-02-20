/**
 * plan_runner.ts
 * ---
 * Executes a validated CodePlan through four phases:
 *
 *  Phase 1 --- RESOLVE
 *    For every function with state=present, call the model with a clean
 *    context to generate the function body. Store results keyed by streamID.
 *    Resolutions run in parallel (Promise.all).
 *
 *  Phase 2 --- DRY APPLY
 *    Apply all CodeEdit ops in-memory with Codeq. Collect every error across
 *    all resources before aborting --- gives the model a complete picture.
 *    If any errors → return error list, do not write.
 *
 *  Phase 3 --- CONFLICT GUARD
 *    Hash affected files at plan-start (snapshotted before phase 1).
 *    Re-hash just before writing. Any change → abort with conflict report.
 *
 *  Phase 4 --- EXECUTE
 *    CodeEdit items: Codeq writes each file (already uses atomic rename).
 *    Ansible items:  pipe JSON to `uv run codectl` subprocess, read report.
 */

import { createHash } from "node:crypto"
import { join, isAbsolute } from "node:path"
import { readFileSync } from "node:fs"
import { consola } from "consola"
import { Codeq, CodeKind, CodePart } from "./codeq/codeq"
import type {
  CodePlan,
  CodeEditItem,
  AnsibleItem,
  PlanItem,
  Resource,
  FunctionEnsure,
} from "./codeplan.schema"
import type { KoboldAdapter } from "./kobold"

// ---
// Types
// ---

export type StreamResolution = {
  streamID: string
  name: string
  body: string
}

export type DryApplyError = {
  resource: string
  operation: string
  error: string
}

export type AnsibleTaskResult = {
  name: string
  status: "ok" | "changed" | "failed" | "skipped" | "unreachable"
  message: string
}

export type AnsibleReport = {
  ok: boolean
  results: AnsibleTaskResult[]
  error?: string
}

export type PlanRunResult = {
  ok: boolean
  /** Phase that stopped execution (undefined = completed) */
  failedPhase?: "resolve" | "dry_apply" | "conflict" | "execute"
  dryApplyErrors?: DryApplyError[]
  conflictedFiles?: string[]
  ansibleReport?: AnsibleReport
  written?: string[]
  error?: string
}

// ---
// Helpers
// ---

function resolvePath(gitRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(gitRoot, path)
}

function hashFile(path: string): string {
  try {
    const content = readFileSync(path)
    return createHash("sha256").update(content).digest("hex")

  } catch {
    // File doesn't exist yet - that's fine, hash as empty
    return ""
  }
}

function affectedPaths(items: CodeEditItem[], gitRoot: string): string[] {
  return [...new Set(
    items.flatMap(item => item.spec.resources.map(r => resolvePath(gitRoot, r.path)))
  )]
}

// ---
// Phase 1 --- Stream resolution
// ---

async function resolveStreams(
  items: CodeEditItem[],
  adapter: KoboldAdapter,
  gitRoot: string,
): Promise<Map<string, StreamResolution>> {
  const jobs: Array<{ streamID: string; name: string; path: string }> = []

  for (const item of items) {
    for (const resource of item.spec.resources) {

      const absPath = resolvePath(gitRoot, resource.path)
      for (const fn of resource.ensure.functions ?? []) {
        if (fn.state === "present") {
          jobs.push({ streamID: fn.streamID, name: fn.name, path: absPath })
        }
      }

    }
  }

  if (jobs.length === 0) return new Map()

  consola.info(`Resolving ${jobs.length} stream(s)...`)

  const resolutions = await Promise.all(jobs.map(async (job) => {
    // Build a minimal file map for context
    let fileContext = ""
    try {
      const codeq = await Codeq.fromFile(job.path)
      fileContext = codeq.fileMap().join("\n")

    } catch {
      fileContext = "(new file)"
    }

    const prompt = [
      `Implement the function \`${job.name}\` for the file \`${job.path}\`.`,
      ``,
      `Current file structure:`,
      fileContext,
      ``,
      // TODO pass target dynamically
      `Return ONLY the function body (the code inside the function, not the def line).`,
      `No markdown, no explanation.`,
    ].join("\n")

    const parsed = await adapter.generate([
      { role: "system", content: "You are a code generation assistant. Output only raw code." },
      { role: "user", content: prompt },
    ])

    return {
      streamID: job.streamID,
      name: job.name,
      body: parsed.content.trim(),
    } satisfies StreamResolution
  }))

  const map = new Map<string, StreamResolution>()
  for (const r of resolutions) map.set(r.streamID, r)

  return map
}

// ---
// Phase 2 --- Dry apply
// ---

const STUB_BODY = `raise NotImplementedError("not yet implemented")`

async function dryApply(
  items: CodeEditItem[],
  resolutions: Map<string, StreamResolution>,
  gitRoot: string,
): Promise<{ errors: DryApplyError[]; codeqInstances: Map<string, Codeq> }> {
  const errors: DryApplyError[] = []
  const instances = new Map<string, Codeq>()

  for (const item of items) {
    for (const resource of item.spec.resources) {
      const absPath = resolvePath(gitRoot, resource.path)

      let codeq: Codeq
      try {
        codeq = await Codeq.fromFile(absPath)

      } catch {
        // File doesn't exist yet --- start from empty
        codeq = Codeq.fromSource("", resource.path)
      }

      instances.set(absPath, codeq)

      // Imports
      for (const stmt of resource.ensure.imports ?? []) {
        try {
          codeq.addImport(stmt)

        } catch (err) {
          errors.push({ resource: resource.path, operation: `import: ${stmt}`, error: String(err) })
        }
      }

      // Functions
      for (const fn of resource.ensure.functions ?? []) {
        if (fn.state === "absent") {
          // Dry-check: just verify we can find it (or that it's already gone --- ok either way)
          try {
            const existing = codeq.retrieve(CodeKind.Func, fn.name, CodePart.Node)
            if (existing) {
              // Would be removed --- no error
            }

          } catch (err) {
            errors.push({ resource: resource.path, operation: `remove function: ${fn.name}`, error: String(err) })
          }

          continue
        }

        // state === "present"
        const resolution = resolutions.get(fn.streamID)
        const body = resolution?.body ?? STUB_BODY

        const existing = (() => {
          try { return codeq.retrieve(CodeKind.Func, fn.name, CodePart.Node) }

          catch { return null }
        })()

        if (existing === null || existing === undefined) {
          // Function doesn't exist --- we'll append it in the write phase.
          // Validate that the resolved body at least parses by doing a trial fromSource.
          const resolution = resolutions.get(fn.streamID)
          const body = resolution?.body ?? STUB_BODY
          const indented = body.split("\n").map(l => `    ${l}`).join("\n")
          const trial = `def ${fn.name}():\n${indented}\n`
          try {
            Codeq.fromSource(trial)

          } catch (err) {
            errors.push({ resource: resource.path, operation: `add function: ${fn.name}`, error: String(err) })
          }

        } else {
          // Function exists --- try replacing logic
          try {
            codeq.replace(CodeKind.Func, fn.name, CodePart.Logic, body)

          } catch (err) {
            errors.push({ resource: resource.path, operation: `replace logic: ${fn.name}`, error: String(err) })
          }
        }
      }
    }
  }

  return { errors, codeqInstances: instances }
}

// ---
// Phase 4a --- CodeEdit write
// ---

async function writeCodeEdits(
  items: CodeEditItem[],
  resolutions: Map<string, StreamResolution>,
  instances: Map<string, Codeq>,
  gitRoot: string,
): Promise<string[]> {
  const written: string[] = []

  for (const item of items) {
    for (const resource of item.spec.resources) {
      const absPath = resolvePath(gitRoot, resource.path)
      let codeq = instances.get(absPath)!

      // Functions with state=absent: remove by rebuilding source without them
      for (const fn of resource.ensure.functions ?? []) {
        if (fn.state === "absent") {
          const existing = (() => {
            try { return codeq.retrieve(CodeKind.Func, fn.name, CodePart.Node) }

            catch { return null }
          })()

          if (existing) {
            let src = codeq.toSource()
            const idx = src.indexOf(existing)
            if (idx !== -1) {
              const end = idx + existing.length + (src[idx + existing.length] === "\n" ? 1 : 0)
              src = src.slice(0, idx) + src.slice(end)
              codeq = Codeq.fromSource(src, resource.path)
              instances.set(absPath, codeq)
            }
          }

          continue
        }

        // state=present: if function didn't exist during dry-apply, append it now
        const nowExists = (() => {
          try { return codeq.retrieve(CodeKind.Func, fn.name, CodePart.Node) !== null }

          catch { return false }
        })()

        if (!nowExists) {
          const resolution = resolutions.get(fn.streamID)
          const body = resolution?.body ?? STUB_BODY
          const indented = body.split("\n").map(l => `    ${l}`).join("\n")
          const stub = `\n\ndef ${fn.name}():\n${indented}\n`
          const src = codeq.toSource() + stub
          codeq = Codeq.fromSource(src, resource.path)
          instances.set(absPath, codeq)
        }
      }

      const dest = await codeq.writeFile(absPath)
      written.push(dest)
    }
  }

  return written
}

// ---
// Phase 4b --- Ansible execution
// ---

async function runAnsible(
  items: AnsibleItem[],
  backendDir: string,
): Promise<AnsibleReport> {
  const payload = JSON.stringify({ items })

  const proc = Bun.spawn(["uv", "run", "codectl"], {
    cwd: backendDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  proc.stdin.write(payload)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (!stdout.trim()) {
    return {
      ok: false,
      results: [],
      error: stderr || `codectl backend exited ${proc.exitCode} with no output`,
    }
  }

  try {
    return JSON.parse(stdout) as AnsibleReport

  } catch (err) {
    return { ok: false, results: [], error: `Failed to parse backend output: ${err}\n${stdout}` }
  }
}

// ---
// Main entry point
// ---

export type PlanRunnerConfig = {
  adapter: KoboldAdapter
  gitRoot: string
  /** Path to the backend/ directory containing pyproject.toml */
  backendDir: string
}

export async function runPlan(
  plan: CodePlan,
  config: PlanRunnerConfig,
): Promise<PlanRunResult> {
  const { adapter, gitRoot, backendDir } = config

  // Partition and sort by metadata.order
  const sorted = [...plan.codePlan].sort(
    (a, b) => (a.metadata.order ?? 0) - (b.metadata.order ?? 0)
  )
  const codeEditItems = sorted.filter((i): i is CodeEditItem => i.kind === "CodeEdit")
  const ansibleItems = sorted.filter((i): i is AnsibleItem => i.kind === "Ansible")

  // Snapshot file hashes before any work begins
  const affected = affectedPaths(codeEditItems, gitRoot)
  const snapshots = new Map(affected.map(p => [p, hashFile(p)]))

  // --- Phase 1: Resolve streams ---
  consola.start("Phase 1: resolving streams")

  let resolutions: Map<string, StreamResolution>
  try {
    resolutions = await resolveStreams(codeEditItems, adapter, gitRoot)

  } catch (err) {
    return { ok: false, failedPhase: "resolve", error: String(err) }
  }

  consola.success(`Phase 1: ${resolutions.size} stream(s) resolved`)

  // --- Phase 2: Dry apply ---
  consola.start("Phase 2: dry apply")
  const { errors, codeqInstances } = await dryApply(codeEditItems, resolutions, gitRoot)
  if (errors.length > 0) {
    consola.warn(`Phase 2: ${errors.length} error(s)`)

    return { ok: false, failedPhase: "dry_apply", dryApplyErrors: errors }
  }

  consola.success("Phase 2: dry apply clean")

  // --- Phase 3: Conflict guard ---
  consola.start("Phase 3: conflict check")
  const conflicted = affected.filter(p => hashFile(p) !== snapshots.get(p))
  if (conflicted.length > 0) {
    consola.warn(`Phase 3: ${conflicted.length} file(s) changed since plan started`)

    return { ok: false, failedPhase: "conflict", conflictedFiles: conflicted }
  }

  consola.success("Phase 3: no conflicts")

  // --- Phase 4: Execute ---
  consola.start("Phase 4: executing")
  const written: string[] = []
  let ansibleReport: AnsibleReport | undefined

  // 4a: CodeEdit writes
  if (codeEditItems.length > 0) {
    try {
      const paths = await writeCodeEdits(codeEditItems, resolutions, codeqInstances, gitRoot)
      written.push(...paths)

      consola.success(`Phase 4: wrote ${paths.length} file(s)`)

    } catch (err) {
      return { ok: false, failedPhase: "execute", error: String(err), written }
    }
  }

  // 4b: Ansible
  if (ansibleItems.length > 0) {
    consola.start(`Phase 4: running ${ansibleItems.length} Ansible item(s)`)

    ansibleReport = await runAnsible(ansibleItems, backendDir)

    if (!ansibleReport.ok) {
      consola.warn("Phase 4: Ansible reported failures")

      return { ok: false, failedPhase: "execute", ansibleReport, written }
    }

    consola.success("Phase 4: Ansible ok")
  }

  return { ok: true, written, ansibleReport }
}
