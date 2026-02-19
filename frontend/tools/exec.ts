import type { ToolDefinition, ToolResult } from '../tool'
import type { ToolHandler } from '../orchestrator'

export const BashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a bash command and return the output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute.' },
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
      },
      code: { type: 'string', description: 'The code to execute.' },
    },
    required: ['language', 'code'],
  },
}

export function createExecHandlers(): Record<string, ToolHandler> {
  const bashHandler: ToolHandler = async (args) => {
    const command = args.command as string
    try {
      const proc = Bun.spawn(['bash', '-c', command], {
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
