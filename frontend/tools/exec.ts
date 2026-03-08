import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'

// --- Persistent shell ---

const SENTINEL = '__CODECTL_SENTINEL__'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 40_000

// How long to wait for the sentinel after sending SIGINT on timeout.
const RECOVERY_TIMEOUT_MS = 3_000

/**
 * A truly persistent bash session. One bash process lives for the lifetime of
 * the Orchestrator. Every exec() writes a command + sentinel to stdin and reads
 * stdout/stderr until the sentinel line appears.
 *
 * Design invariants:
 *   - exec() calls are serialised by a promise-chain lock so streams are never
 *     read by two concurrent callers.
 *   - Timeout is implemented via Promise.race so reader.read() never blocks
 *     past the deadline.
 *   - On timeout: SIGINT is sent + sentinel re-emitted.  If the sentinel
 *     doesn't arrive within RECOVERY_TIMEOUT_MS the shell is restarted.
 *   - A generation counter prevents a lagging stderr drain from writing into
 *     a subsequent call's buffer after restart.
 */
export class PersistentShell {
  private proc!: ReturnType<typeof Bun.spawn>
  private reader!: ReadableStreamDefaultReader<Uint8Array>
  private errReader!: ReadableStreamDefaultReader<Uint8Array>
  private cwd: string
  private buf = ''
  private readonly initialCwd: string

  // Serialise all exec() calls: each one awaits the previous chain entry.
  private lockChain: Promise<void> = Promise.resolve()

  // Incremented on every _spawn(). Stderr drain loops use this to bail out
  // if the shell is restarted underneath them.
  private generation = 0

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
    this.generation++
    this.reader    = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    this.errReader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader()
  }

  restart(): void {
    try { this.proc.kill() } catch { /* already dead */ }
    this.cwd = this.initialCwd
    this._spawn()
  }

  // -------------------------------------------------------------------------
  // Public exec — acquires the lock then delegates to _exec
  // -------------------------------------------------------------------------

  async exec(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let unlock!: () => void
    const prev = this.lockChain
    this.lockChain = new Promise<void>(r => { unlock = r })
    await prev
    try {
      return await this._exec(command, timeoutMs)
    } finally {
      unlock()
    }
  }

  // -------------------------------------------------------------------------
  // Internal exec — runs only when the lock is held
  // -------------------------------------------------------------------------

  private async _exec(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const gen      = this.generation
    const decoder  = new TextDecoder()
    const encoder  = new TextEncoder()
    const deadline = Date.now() + timeoutMs

    // Race a single reader chunk against a deadline (ms).
    // Returns null when the deadline fires, IteratorResult otherwise.
    const readChunk = <T>(
      reader: ReadableStreamDefaultReader<T>,
      by: number,
    ): Promise<{ value: T | undefined; done: boolean } | null> => {
      const remaining = by - Date.now()
      if (remaining <= 0) return Promise.resolve(null)
      return Promise.race([
        reader.read() as Promise<{ value: T | undefined; done: boolean }>,
        new Promise<null>(resolve => setTimeout(() => resolve(null), remaining)),
      ])
    }

    // Drain stderr concurrently into a local buffer for this call only.
    // The generation guard stops the loop if the shell is restarted.
    let localErr = ''
    const stderrDone = (async () => {
      try {
        while (this.generation === gen) {
          // Give stderr a little extra time past the command deadline
          const chunk = await readChunk(this.errReader, deadline + 500)
          if (chunk === null || chunk.done) break
          if (chunk.value) {
            localErr += decoder.decode(chunk.value)
            if (this.buf.includes(SENTINEL)) break
          }
        }
      } catch { /* ignore */ }
    })()

    // Write command + sentinel probe to stdin
    const sentinelCmd = `\nprintf '\\n${SENTINEL} %d %s\\n' $? "$(pwd)"\n`
    this.proc.stdin!.write(encoder.encode(command + sentinelCmd))
    await this.proc.stdin!.flush()

    // Read stdout until sentinel appears, bailing if the deadline fires
    let timedOut = false
    while (!this.buf.includes(SENTINEL)) {
      const chunk = await readChunk(this.reader, deadline)
      if (chunk === null)    { timedOut = true; break }
      if (chunk.done)        { throw new Error('bash process exited unexpectedly') }
      if (chunk.value)       { this.buf += decoder.decode(chunk.value) }
    }

    // -----------------------------------------------------------------------
    // Timeout recovery: send SIGINT + fresh sentinel, wait RECOVERY_TIMEOUT_MS
    // -----------------------------------------------------------------------
    if (timedOut) {
      const recoveryBy = Date.now() + RECOVERY_TIMEOUT_MS
      try {
        this.proc.stdin!.write(
          encoder.encode(`\x03\nprintf '\\n${SENTINEL} %d %s\\n' 130 "$(pwd)"\n`)
        )
        await this.proc.stdin!.flush()

        while (!this.buf.includes(SENTINEL)) {
          const chunk = await readChunk(this.reader, recoveryBy)
          if (chunk === null || chunk.done) {
            // Recovery failed — clean restart so next call starts fresh
            this.restart()
            throw new Error(`bash command timed out after ${timeoutMs}ms (shell restarted)`)
          }
          if (chunk.value) this.buf += decoder.decode(chunk.value)
        }
        // Recovery succeeded — parse the sentinel so buf stays clean, then throw
        this._consumeSentinel()
      } catch (e) {
        await stderrDone
        if (String(e).includes('timed out')) throw e
        this.restart()
        throw new Error(`bash command timed out after ${timeoutMs}ms (shell restarted)`)
      }

      await stderrDone
      throw new Error(`bash command timed out after ${timeoutMs}ms`)
    }

    // -----------------------------------------------------------------------
    // Normal completion — parse sentinel line
    // -----------------------------------------------------------------------
    const { output, exitCode } = this._consumeSentinel()

    // Let stderr drain settle (50ms grace period)
    await Promise.race([stderrDone, new Promise(r => setTimeout(r, 50))])

    const stdout = output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${output.length} chars total)`
      : output

    return { stdout, stderr: localErr, exitCode }
  }

  // -------------------------------------------------------------------------
  // Parse + consume the sentinel line from this.buf
  // -------------------------------------------------------------------------
  private _consumeSentinel(): { output: string; exitCode: number } {
    const sentinelIdx = this.buf.indexOf(SENTINEL)
    const output = this.buf.slice(0, sentinelIdx)
    const rest   = this.buf.slice(sentinelIdx)

    const lineEnd     = rest.indexOf('\n')
    const sentinelLine = rest.slice(0, lineEnd === -1 ? undefined : lineEnd + 1)
    this.buf = lineEnd === -1 ? '' : rest.slice(lineEnd + 1)

    const match = sentinelLine.trim().match(new RegExp(`^${SENTINEL}\\s+(\\d+)\\s+(.+)$`))
    const exitCode = match ? parseInt(match[1]!, 10) : 0
    if (match) this.cwd = match[2]!.trim()

    return { output, exitCode }
  }
}

// --- Tool definitions ---

export const BashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Execute a bash command in a persistent shell session. Environment variables, working ' +
    'directory, sourced files, and aliases all persist across calls. Set restart=true to ' +
    'reset the session to a clean state. ' +
    'Commands are interrupted with SIGINT on timeout. ' +
    'Set background=true to fire-and-forget long-running commands (disowned subprocess).',
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
        description: 'Timeout in milliseconds (default: 30000). Command receives SIGINT on expiry.',
      },
      background: {
        type: 'boolean',
        description:
          'If true, run the command in the background (appended & disown). ' +
          'Returns immediately with {"pid": N}; use bash to check status or tail log files.',
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
  const sh = shell ?? new PersistentShell()

  const bashHandler: ToolHandler = async (args) => {
    if (args.restart) {
      sh.restart()
      return ok({ restarted: true, cwd: sh.getCwd() })
    }

    let command = args.command as string
    if (!command) return err("'command' or 'restart' required")

    // background=true: wrap command to detach and return the pid immediately
    if (args.background) {
      command = `{ ${command} ; } & disown $!; echo "{\\"pid\\":$!}"`
    }

    const timeout = typeof args.timeout === 'number' ? args.timeout : undefined

    try {
      const { stdout, stderr, exitCode } = await sh.exec(command, timeout)
      if (exitCode !== 0) {
        // Non-zero exit codes are errors — include stdout/stderr so the model
        // sees what went wrong without needing a separate read.
        const detail = [stderr, stdout].filter(Boolean).join('\n').trim()
        return err(`exit ${exitCode}${detail ? ': ' + detail : ''}`)
      }
      return ok({ stdout, stderr, exitCode, cwd: sh.getCwd() })
    } catch (e) {
      return err(String(e))
    }
  }

  const pythonHandler: ToolHandler = async (args) => {
    const code = args.code as string
    try {
      const proc = Bun.spawn(['python', '-c', code], { stdout: 'pipe', stderr: 'pipe' })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      return ok({ stdout, stderr, exitCode: proc.exitCode })
    } catch (e) {
      return err(String(e))
    }
  }

  const tsHandler: ToolHandler = async (args) => {
    const code = args.code as string
    try {
      const proc = Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      return ok({ stdout, stderr, exitCode: proc.exitCode })
    } catch (e) {
      return err(String(e))
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

  return { bash: bashHandler, python: pythonHandler, typescript: tsHandler, code: codeHandler }
}

export const ExecTools: ToolDefinition[] = [BashTool, PythonTool, TypeScriptTool, CodeTool]
