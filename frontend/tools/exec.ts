import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'

// --- Persistent shell ---

/**
 * A lightweight persistent shell that preserves the working directory across
 * calls. Each `exec` spawns a new `bash` process but in the last known `cwd`,
 * so `cd` changes accumulate as expected.
 *
 * After every command we append a sentinel echo so we can reliably capture
 * the post-command `pwd` without parsing stderr or any other heuristic.
 */
export class PersistentShell {
  private cwd: string

  constructor(initialCwd: string = process.cwd()) {
    this.cwd = initialCwd
  }

  getCwd(): string { return this.cwd }

  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    // Sentinel line we inject so we can always find the final cwd even when the
    // command itself produces no output on stdout.
    const SENTINEL = '__CODECTL_CWD__'
    const wrapped = `${command}\nprintf '\\n${SENTINEL}=%s\\n' "$(pwd)"`

    const proc = Bun.spawn(['bash', '-c', wrapped], {
      cwd: this.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    // Extract and strip the sentinel line from stdout
    const sentinelRe = new RegExp(`\\n?${SENTINEL}=(.+)\\n?$`)
    const sentinelMatch = stdout.match(sentinelRe)
    if (sentinelMatch) {
      this.cwd = sentinelMatch[1]!.trim()
      stdout = stdout.replace(sentinelRe, '')
    }

    return { stdout, stderr, exitCode: proc.exitCode }
  }
}

// --- Tool definitions ---

export const BashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Execute a bash command in the persistent shell. The working directory is preserved ' +
    'between calls, so `cd` commands take effect for subsequent invocations.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
        aliases: ['cmd', 'shell', 'run'],
      },
    },
    required: ['command'],
  },
}

export const PythonTool: ToolDefinition = {
  name: 'python',
  description: 'Execute Python code and return the output.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The Python code to execute.' },
    },
    required: ['code'],
  },
}

export const TypeScriptTool: ToolDefinition = {
  name: 'typescript',
  description: 'Execute TypeScript code using Bun and return the output.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The TypeScript code to execute.' },
    },
    required: ['code'],
  },
}

export const CodeTool: ToolDefinition = {
  name: 'code',
  description: 'Execute code in a specified language and return the output.',
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['bash', 'python', 'typescript', 'sh', 'shell', 'py', 'ts'],
        description: 'The programming language of the code.',
        aliases: ['lang'],
      },
      code: {
        type: 'string',
        description: 'The code to execute.',
        aliases: ['src', 'source'],
      },
    },
    required: ['language', 'code'],
  },
}

// --- Handler factories ---

export function createExecHandlers(shell?: PersistentShell): Record<string, ToolHandler> {
  // Each Orchestrator gets its own persistent shell unless one is injected
  const sh = shell ?? new PersistentShell()

  const bashHandler: ToolHandler = async (args) => {
    const command = args.command as string
    try {
      const { stdout, stderr, exitCode } = await sh.exec(command)
      return { result: { stdout, stderr, exitCode, cwd: sh.getCwd() } }

    } catch (err) {
      return { result: null, error: String(err) }
    }
  }

  const pythonHandler: ToolHandler = async (args) => {
    const code = args.code as string
    try {
      const proc = Bun.spawn(['python', '-c', code], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      return { result: { stdout, stderr, exitCode: proc.exitCode } }

    } catch (err) {
      return { result: null, error: String(err) }
    }
  }

  const tsHandler: ToolHandler = async (args) => {
    const code = args.code as string
    try {
      // Use bun -e to run code string
      const proc = Bun.spawn(['bun', '-e', code], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      return { result: { stdout, stderr, exitCode: proc.exitCode } }

    } catch (err) {
      return { result: null, error: String(err) }
    }
  }

  const codeHandler: ToolHandler = async (args) => {
    const lang = args.language as string
    const code = args.code as string

    if (lang === 'bash' || lang === 'sh' || lang === 'shell') return bashHandler({ command: code })
    if (lang === 'python' || lang === 'py') return pythonHandler({ code })
    if (lang === 'typescript' || lang === 'ts') return tsHandler({ code })

    return { result: null, error: `Unsupported language: ${lang}` }
  }

  return {
    bash: bashHandler,
    python: pythonHandler,
    typescript: tsHandler,
    code: codeHandler,
  }
}

export const ExecTools: ToolDefinition[] = [BashTool, PythonTool, TypeScriptTool, CodeTool]
