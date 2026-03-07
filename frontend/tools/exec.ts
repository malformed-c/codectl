import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'

// --- Persistent shell ---

const SENTINEL = '__CODECTL_SENTINEL__'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 40_000

/**
 * A truly persistent bash session. One bash process lives for the lifetime of
 * the Orchestrator. Every exec() writes a command + sentinel to stdin and reads
 * stdout/stderr until the sentinel line appears, so env vars, aliases, sourced
 * files, and working directory all survive across calls.
 *
 * After each command we emit:
 *   printf '\n__CODECTL_SENTINEL__ %d %s\n' $? "$(pwd)"
 * which lets us recover exit code and cwd without any extra process.
 *
 * restart() kills the current process and spawns a fresh one, matching the
 * Anthropic bash tool's `restart` parameter.
 */
export class PersistentShell {
  private proc!: ReturnType<typeof Bun.spawn>
  private reader!: ReadableStreamDefaultReader<Uint8Array>
  private errReader!: ReadableStreamDefaultReader<Uint8Array>
  private cwd: string
  private buf = ''
  private errBuf = ''
  private readonly initialCwd: string

  constructor(initialCwd: string = process.cwd()) {
    this.initialCwd = initialCwd
    this.cwd = initialCwd
    this._spawn()
  }

  getCwd(): string { return this.cwd }

  private _spawn(): void {
    this.proc = Bun.spawn(['bash', '--norc', '--noprofile'], {
      cwd: this.initialCwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    this.buf = ''
    this.errBuf = ''
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    this.errReader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader()
  }

  restart(): void {
    try { this.proc.kill() } catch { /* already dead */ }
    this.cwd = this.initialCwd
    this._spawn()
  }

  async exec(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Write command + sentinel to stdin
    const sentinelCmd = `\nprintf '\\n${SENTINEL} %d %s\\n' $? "$(pwd)"\n`
    const encoder = new TextEncoder()
    this.proc.stdin!.write(encoder.encode(command + sentinelCmd))
    await this.proc.stdin!.flush()

    const deadline = Date.now() + timeoutMs
    const decoder = new TextDecoder()

    // Drain stderr concurrently (best-effort, non-blocking)
    const drainStderr = async () => {
      try {
        while (true) {
          const { value, done } = await this.errReader.read()
          if (done) break
          this.errBuf += decoder.decode(value)
          // stop draining once sentinel is in stdout to avoid hanging
          if (this.buf.includes(SENTINEL)) break
        }
      } catch { /* ignore */ }
    }
    drainStderr()

    // Read stdout until sentinel appears
    while (!this.buf.includes(SENTINEL)) {
      if (Date.now() > deadline) {
        throw new Error(`bash command timed out after ${timeoutMs}ms`)
      }
      const { value, done } = await this.reader.read()
      if (done) throw new Error('bash process exited unexpectedly')
      this.buf += decoder.decode(value)
    }

    // Split at sentinel
    const sentinelIdx = this.buf.indexOf(SENTINEL)
    const output = this.buf.slice(0, sentinelIdx)
    const rest   = this.buf.slice(sentinelIdx)

    // Parse sentinel line: __CODECTL_SENTINEL__ <exitCode> <cwd>
    const sentinelLineEnd = rest.indexOf('\n')
    const sentinelLine = rest.slice(0, sentinelLineEnd === -1 ? undefined : sentinelLineEnd + 1)
    this.buf = sentinelLineEnd === -1 ? '' : rest.slice(sentinelLineEnd + 1)

    const match = sentinelLine.trim().match(new RegExp(`^${SENTINEL}\\s+(\\d+)\\s+(.+)$`))
    const exitCode = match ? parseInt(match[1]!, 10) : 0
    if (match) this.cwd = match[2]!.trim()

    const stderr = this.errBuf
    this.errBuf = ''

    // Truncate very large outputs to keep context window sane
    const stdout = output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${output.length} chars total)`
      : output

    return { stdout, stderr, exitCode }
  }
}

// --- Tool definitions ---

export const BashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Execute a bash command in a persistent shell session. Environment variables, working ' +
    'directory, sourced files, and aliases all persist across calls. Set restart=true to ' +
    'reset the session to a clean state.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
        aliases: ['cmd', 'shell', 'run'],
      },
      restart: {
        type: 'boolean',
        description: 'If true, restart the bash session (clears all state). Omit command when using restart.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000).',
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
    if (args.restart) {
      sh.restart()
      return ok({ restarted: true, cwd: sh.getCwd()})
    }
    const command = args.command as string
    if (!command) return err("'command' or 'restart' required")
    const timeout = typeof args.timeout === 'number' ? args.timeout : undefined
    try {
      const { stdout, stderr, exitCode } = await sh.exec(command, timeout)
      return ok({ stdout, stderr, exitCode, cwd: sh.getCwd()})

    } catch (err) {
      return err(String(err))
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

      return ok({ stdout, stderr, exitCode: proc.exitCode})

    } catch (err) {
      return err(String(err))
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

      return ok({ stdout, stderr, exitCode: proc.exitCode})

    } catch (err) {
      return err(String(err))
    }
  }

  const codeHandler: ToolHandler = async (args) => {
    const lang = args.language as string
    const code = args.code as string

    if (lang === 'bash' || lang === 'sh' || lang === 'shell') return bashHandler({ command: code })
    if (lang === 'python' || lang === 'py') return pythonHandler({ code })
    if (lang === 'typescript' || lang === 'ts') return tsHandler({ code })

    return err(`Unsupported language: ${lang}`)
  }

  return {
    bash: bashHandler,
    python: pythonHandler,
    typescript: tsHandler,
    code: codeHandler,
  }
}

export const ExecTools: ToolDefinition[] = [BashTool, PythonTool, TypeScriptTool, CodeTool]
