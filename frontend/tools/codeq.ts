import { Codeq, CodeKind, CodePart } from '../codeq/codeq'
import type { ToolDefinition, ToolResult } from '../tool'
import { ok, err } from '../tool'
import type { ToolHandler } from '../orchestrator'
import { join, isAbsolute, relative, extname } from 'node:path'

// --- Helpers ---

function resolvePath(gitRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(gitRoot, path)
}

function codeKindFrom(s: string): CodeKind {
  if (s === 'func' || s === 'function') return CodeKind.Func
  if (s === 'class') return CodeKind.Class
  throw new Error(`Unknown code kind: ${s}. Use 'func' or 'class'.`)
}

function codePartFrom(s: string): CodePart {
  const map: Record<string, CodePart> = {
    node: CodePart.Node,
    body: CodePart.Body,
    logic: CodePart.Logic,
    docstring: CodePart.Docstring,
    params: CodePart.Params,
    return_type: CodePart.ReturnType,
    superclasses: CodePart.Superclasses,
  }
  const part = map[s]
  if (!part) throw new Error(`Unknown code part: ${s}. Use: ${Object.keys(map).join(', ')}.`)
  return part
}

// --- Helpers ---

const SUPPORTED_EXTS = new Set(['.py', '.ts', '.tsx', '.mts', '.cts'])

function isSupportedFile(path: string): boolean {
  return SUPPORTED_EXTS.has(extname(path).toLowerCase())
}

async function gitTrackedFiles(gitRoot: string): Promise<string[]> {
  const proc = Bun.spawn(['git', 'ls-files'], {
    cwd: gitRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text.split('\n').filter(Boolean)
}

// --- Tool definitions ---

export const CodeqRepomapTool: ToolDefinition = {
  name: 'codeq_repomap',
  description:
    'Get a structural overview of the entire repository - directory tree with ' +
    'function and class signatures per source file. Use this first to understand ' +
    'the codebase before diving into specific files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Subdirectory to scope the map to, relative to git root. Omit for full repo.',
      },
    },
    required: [],
  },
  returns: {
    type: 'object',
    properties: {
      repomap: { type: 'string', description: 'Structural overview of the repository.' },
    },
  },
}

export const CodeqFileMapTool: ToolDefinition = {
  name: 'codeq_filemap',
  description:
    'Get a compact structural overview of a source file - functions, classes, ' +
    'signatures, decorators, and docstring previews. Use this to understand a file before editing.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file, relative to git root.',
      },
    },
    required: ['path'],
  },
  returns: {
    type: 'object',
    properties: {
      filemap: { type: 'string', description: 'Compact structural view of the file.' },
    },
  },
}

export const CodeqRetrieveTool: ToolDefinition = {
  name: 'codeq_retrieve',
  description:
    'Retrieve a specific part of a function or class from a source file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to git root.' },
      kind: { type: 'string', enum: ['func', 'class'], description: 'Whether target is a function or class.' },
      target: { type: 'string', description: 'Name of the function or class. Use ClassName.method for methods.' },
      part: {
        type: 'string',
        enum: ['node', 'body', 'logic', 'docstring', 'params', 'return_type', 'superclasses'],
        description: 'Which part to retrieve.',
      },
    },
    required: ['path', 'kind', 'target', 'part'],
  },
  returns: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The retrieved source text.' },
    },
  },
}

export const CodeqReplaceTool: ToolDefinition = {
  name: 'codeq_replace',
  description:
    'Replace a specific part of a function or class in a source file. ' +
    'Writes the change atomically. Use codeq_filemap first to understand the structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to git root.' },
      kind: { type: 'string', enum: ['func', 'class'], description: 'Whether target is a function or class.' },
      target: { type: 'string', description: 'Name of the function or class. Use ClassName.method for methods.' },
      part: {
        type: 'string',
        enum: ['node', 'body', 'logic', 'docstring', 'params', 'return_type', 'superclasses'],
        description: 'Which part to replace.',
      },
      content: { type: 'string', description: 'New content to write.' },
    },
    required: ['path', 'kind', 'target', 'part', 'content'],
  },
  returns: {
    type: 'object',
    properties: {
      written: { type: 'string', description: 'The file path that was written.' },
    },
  },
}

export const CodeqAddImportTool: ToolDefinition = {
  name: 'codeq_add_import',
  description:
    'Add an import statement to a source file. Skips if already present. ' +
    'Inserts after existing imports, respecting shebang and module docstring.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to git root.' },
      import_stmt: { type: 'string', description: 'The import statement, e.g. "from jose import jwt".' },
    },
    required: ['path', 'import_stmt'],
  },
  returns: {
    type: 'object',
    properties: {
      added: { type: 'boolean', description: 'False if import was already present.' },
    },
  },
}

// --- Handler factories ---

/**
 * Create all codeq handlers bound to a git root.
 * gitRoot is retrieved from orchestrator mode at call time via a getter.
 */
export function createCodeqHandlers(getGitRoot: () => string): Record<string, ToolHandler> {
  const repomapHandler: ToolHandler = async (args) => {
    const gitRoot = getGitRoot()
    const scopeArg = args.path as string | undefined
    const files = await gitTrackedFiles(gitRoot)

    const lines: string[] = []
    let currentDir = ''

    for (const relFile of files.sort()) {
      if (!isSupportedFile(relFile)) continue

      // Scope filter
      if (scopeArg) {
        const scopeNorm = scopeArg.replace(/\/$/, '')
        if (!relFile.startsWith(scopeNorm + '/') && relFile !== scopeNorm) continue
      }

      const dir = relFile.includes('/') ? relFile.slice(0, relFile.lastIndexOf('/')) : ''

      if (dir !== currentDir) {
        if (dir) lines.push(`${dir}/`)
        currentDir = dir
      }

      const fileName = relFile.split('/').pop()!

      try {
        const codeq = await Codeq.fromFile(join(gitRoot, relFile))
        const map = codeq.fileMap()

        lines.push(`  ${fileName}`)

        for (const entry of map) {
          if (entry === '---') continue
          for (const line of entry.split('\n')) {
            const truncated = line.length > 100 ? line.slice(0, 97) + '...' : line
            lines.push(`    ${truncated}`)
          }
        }
      } catch {
        lines.push(`  ${fileName}  (parse error)`)
      }

      if (lines.length > 500) {
        lines.push('  ...')
        lines.push('  (result truncated: too many lines)')

        break
      }
    }

    if (lines.length === 0) return ok({ repomap: '(no supported files found)'})

    return ok({ repomap: lines.join('\n')})
  }

  const fileMapHandler: ToolHandler = async (args) => {
    const path = resolvePath(getGitRoot(), args.path as string)

    const codeq = await Codeq.fromFile(path)

    const lines = codeq.fileMap()

    if (lines.length === 0) return ok({ filemap: '(no functions or classes found)'})

    return ok({ filemap: lines.join('\n')})
  }

  const retrieveHandler: ToolHandler = async (args) => {
    const path = resolvePath(getGitRoot(), args.path as string)
    const codeq = await Codeq.fromFile(path)
    const kind = codeKindFrom(args.kind as string)
    const part = codePartFrom(args.part as string)
    const content = codeq.retrieve(kind, args.target as string, part)

    if (content === null) return err(`${args.kind} '${args.target}' not found in ${args.path}`)

    return ok({ content})
  }

  const replaceHandler: ToolHandler = async (args) => {
    const path = resolvePath(getGitRoot(), args.path as string)
    const codeq = await Codeq.fromFile(path)
    const kind = codeKindFrom(args.kind as string)
    const part = codePartFrom(args.part as string)

    codeq.replace(kind, args.target as string, part, args.content as string)

    const written = await codeq.writeFile(path)

    return ok({ written})
  }

  const addImportHandler: ToolHandler = async (args) => {
    const path = resolvePath(getGitRoot(), args.path as string)

    const codeq = await Codeq.fromFile(path)

    const added = codeq.addImport(args.import_stmt as string)

    if (added) await codeq.writeFile(path)

    return ok({ added})
  }

  return {
    codeq_repomap: repomapHandler,
    codeq_filemap: fileMapHandler,
    codeq_retrieve: retrieveHandler,
    codeq_replace: replaceHandler,
    codeq_add_import: addImportHandler,
  }
}

// --- Convenience: all definitions ---

export const CodeqTools: ToolDefinition[] = [
  CodeqRepomapTool,
  CodeqFileMapTool,
  CodeqRetrieveTool,
  CodeqReplaceTool,
  CodeqAddImportTool,
]
