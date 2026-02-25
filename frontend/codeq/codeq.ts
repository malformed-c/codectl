import { Parser, Node, Language, Tree, Query } from "web-tree-sitter"
import { join, dirname, relative } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { rename } from "node:fs/promises"
import { match } from "ts-pattern"
import consola from "consola"

// --- Types ---

await Parser.init()

// Load WASM
const pythonWasm = await Bun.file("./node_modules/tree-sitter-python/tree-sitter-python.wasm").bytes()
const typescriptWasm = await Bun.file("./node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm").bytes()
const tsxWasm = await Bun.file("./node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm").bytes()

// Load the language
const Python = await Language.load(pythonWasm)
const TypeScript = await Language.load(typescriptWasm)
const TSX = await Language.load(tsxWasm)

/* Capture name -> matching nodes */
type CaptureMap = Map<string, Node[]>

// --- Errors ---

export class CodeqError extends Error { }

export class TargetNotFoundError extends CodeqError {
  constructor(message: string) {
    super(message)

    this.name = "TargetNotFoundError"
  }
}

export class MissingCaptureError extends CodeqError {
  constructor(message: string) {
    super(message)

    this.name = "MissingCaptureError"
  }
}

export class AmbiguousTargetError extends CodeqError {
  constructor(message: string) {
    super(message)

    this.name = "AmbiguousTargetError"
  }
}

// --- Enums ---

export enum CodeKind {
  Func = "func",
  Class = "class",
}

export enum CodePart {
  Node = "node",
  Body = "body",
  Logic = "logic",
  Docstring = "docstring",
  Params = "params",
  ReturnType = "return_type",
  Superclasses = "superclasses",
}

export enum ResourceKind {
  Function = "Function",
  Class = "Class",
}

// --- Schema types (filemap/repomap output) ---

export interface ObjectMeta {
  name: string
  offset: number
}

export interface FunctionSpec {
  params: string
  returnType: string
  docstring: string
  decorators: string[]
}

export interface ClassSpec {
  superclasses: string
  docstring: string
}

export interface CodeqObject {
  apiVersion: "codeq/v1alpha1"
  kind: ResourceKind
  metadata: ObjectMeta
  spec: FunctionSpec | ClassSpec
}

// --- Internal map entries ---

interface FunctionMapEntry {
  start: number
  end: number
  name: string
  params: string
  returnType: string
  docstring: string
  decorators: string[]
  enclosingClass: string | null
}

interface ClassMapEntry {
  start: number
  end: number
  name: string
  superclasses: string
  docstring: string
}

// --- Tree-sitter setup ---

const pyParser = new Parser()
pyParser.setLanguage(Python)

const tsParser = new Parser()
tsParser.setLanguage(TypeScript)

const tsxParser = new Parser()
tsxParser.setLanguage(TSX)

// --- Language config ---

type LangConfig = {
  parser: Parser
  language: Language
  funcsQueryStr: string
  classesQueryStr: string
  importNodeTypes: string[]
  isImportStatement: (stmt: string) => boolean
  importInsertLine: (lines: string[], parser: Parser) => number
}

// --- Query strings ---

// Python
const PY_FUNCS_QUERY_STRING = `
(decorated_definition
    (decorator) @func.decorator
    definition: (function_definition
        name: (identifier) @func.name
        parameters: (parameters) @func.params
        return_type: (type)? @func.return_type
        body: (block
            . (expression_statement (string) @func.docstring)? @func.doc_node
        ) @func.body
    ) @func.node
) @func.decorated_node

(function_definition
    name: (identifier) @func.name
    parameters: (parameters) @func.params
    return_type: (type)? @func.return_type
    body: (block
        . (expression_statement (string) @func.docstring)? @func.doc_node
    ) @func.body
) @func.node
`

const PY_CLASSES_QUERY_STRING = `
(class_definition
    name: (identifier) @class.name
    superclasses: (argument_list)? @class.superclasses
    body: (block
        . (expression_statement (string) @class.docstring)? @class.doc_node
    ) @class.body
) @class.node
`

// TypeScript / TSX
const TS_FUNCS_QUERY_STRING = `
(function_declaration
    name: (identifier) @func.name
    parameters: (formal_parameters) @func.params
    return_type: (type_annotation)? @func.return_type
    body: (statement_block) @func.body
) @func.node

(method_definition
    name: (property_identifier) @func.name
    parameters: (formal_parameters) @func.params
    return_type: (type_annotation)? @func.return_type
    body: (statement_block) @func.body
) @func.node

(arrow_function
    parameters: (formal_parameters) @func.params
    return_type: (type_annotation)? @func.return_type
    body: (_) @func.body
) @func.node

(export_statement
    declaration: (function_declaration
        name: (identifier) @func.name
        parameters: (formal_parameters) @func.params
        return_type: (type_annotation)? @func.return_type
        body: (statement_block) @func.body
    ) @func.node
) @func.decorated_node

(lexical_declaration
    (variable_declarator
        name: (identifier) @func.name
        value: (arrow_function
            parameters: (formal_parameters) @func.params
            return_type: (type_annotation)? @func.return_type
            body: (_) @func.body
        ) @func.node
    )
)
`

const TS_CLASSES_QUERY_STRING = `
(class_declaration
    name: (type_identifier) @class.name
    (class_heritage)? @class.superclasses
    body: (class_body) @class.body
) @class.node

(export_statement
    declaration: (class_declaration
        name: (type_identifier) @class.name
        (class_heritage)? @class.superclasses
        body: (class_body) @class.body
    ) @class.node
) @class.decorated_node
`

function pyImportInsertLine(lines: string[], parser: Parser): number {
  let start = 0
  if (lines[0]?.startsWith("#!")) start = 1
  if (lines[start] && /^#\s*-\*-\s*coding:/.test(lines[start])) start += 1

  const joined = lines.join("\n")
  const tmpTree = parser.parse(joined)
  const root = tmpTree.rootNode
  const children = root.children.filter(
    (c) => c.type !== "comment" && c.type !== "\n"
  )

  if (
    children[0]?.type === "expression_statement"
    && children[0].children[0]?.type === "string"
  ) {
    start = Math.max(start, children[0].endPosition.row + 1)
  }

  let importEnd = start
  for (const child of root.children) {
    if (child.startPosition.row < start) continue
    if (child.type === "import_statement" || child.type === "import_from_statement") {
      importEnd = Math.max(importEnd, child.endPosition.row + 1)
    }
  }

  return importEnd > start ? importEnd : start
}

function tsImportInsertLine(lines: string[], parser: Parser): number {
  const joined = lines.join("\n")
  const tmpTree = parser.parse(joined)
  const root = tmpTree.rootNode

  let importEnd = 0
  for (const child of root.children) {
    if (child.type === "import_statement" || child.type === "import_declaration") {
      importEnd = Math.max(importEnd, child.endPosition.row + 1)
    }
  }

  return importEnd
}

const PY_LANG: LangConfig = {
  parser: pyParser,
  language: Python,
  funcsQueryStr: PY_FUNCS_QUERY_STRING,
  classesQueryStr: PY_CLASSES_QUERY_STRING,
  importNodeTypes: ["import_statement", "import_from_statement"],
  isImportStatement: (s) => /^(import\s+|from\s+\S+\s+import\s+)/.test(s),
  importInsertLine: pyImportInsertLine,
}

const TS_LANG: LangConfig = {
  parser: tsParser,
  language: TypeScript,
  funcsQueryStr: TS_FUNCS_QUERY_STRING,
  classesQueryStr: TS_CLASSES_QUERY_STRING,
  importNodeTypes: ["import_statement", "import_declaration"],
  isImportStatement: (s) => /^import\s/.test(s),
  importInsertLine: tsImportInsertLine,
}

const TSX_LANG: LangConfig = {
  ...TS_LANG,
  parser: tsxParser,
  language: TSX,
}

function langConfigForPath(path: string): LangConfig {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "tsx") return TSX_LANG
  if (ext === "ts" || ext === "mts" || ext === "cts") return TS_LANG
  return PY_LANG  // default
}

// --- Helpers ---

/* Convert tree-sitter Node.js captures array -> CaptureMap */
function toCaptureMap(
  captures: Array<{ name: string; node: Node }>
): CaptureMap {
  const map: CaptureMap = new Map()

  for (const { name, node } of captures) {

    const existing = map.get(name)

    if (existing) {
      existing.push(node)

    } else {
      map.set(name, [node])
    }
  }

  return map
}

/* Dedent + strip a string (mirrors Python textwrap.dedent + strip) */
function dedentStrip(text: string): string {
  const lines = text.split("\n")
  const nonEmpty = lines.filter((l) => l.trim().length > 0)

  if (nonEmpty.length === 0) return text.trim()

  const minIndent = Math.min(
    ...nonEmpty.map((l) => l.length - l.trimStart().length)
  )

  return lines
    .map((l) => l.slice(minIndent))
    .join("\n")
    .trim()
}

/* Re-indent text to `level` spaces, preserving internal relative indentation */
function reindent(text: string, level: number): string {
  const dedented = dedentStrip(text)
  const prefix = " ".repeat(level)

  return dedented
    .split("\n")
    .map((line, i) => (i === 0 ? line : prefix + line))
    .join("\n")
}

/* Splice bytes: returns new Buffer with [start, end) replaced by replacement */
function spliceBuf(
  buf: Buffer,
  start: number,
  end: number,
  replacement: Buffer
): Buffer {
  return Buffer.concat([buf.subarray(0, start), replacement, buf.subarray(end)])
}

// --- Main class ---

export class Codeq {
  private tree: Tree
  private sourceBytes: Buffer
  private readonly filePath: string
  private readonly lang: LangConfig

  private readonly funcsQuery: Query
  private readonly classesQuery: Query

  constructor(tree: Tree, source: Buffer, lang: LangConfig, path = "<FILE>") {
    this.tree = tree
    this.sourceBytes = Buffer.from(source)
    this.filePath = path
    this.lang = lang

    this.funcsQuery = new Query(lang.language, lang.funcsQueryStr)
    this.classesQuery = new Query(lang.language, lang.classesQueryStr)
  }

  // --- Factory methods ---

  static fromSource(source: string, path = "<FILE>", lang?: LangConfig): Codeq {
    const l = lang ?? langConfigForPath(path)
    const buf = Buffer.from(source, "utf8")
    const tree = l.parser.parse(source)

    return new Codeq(tree, buf, l, path)
  }

  static async fromFile(filePath: string): Promise<Codeq> {
    const file = Bun.file(filePath)

    const source = await file.text()

    let displayPath: string
    try {
      displayPath = relative(process.cwd(), filePath)

    } catch {
      displayPath = filePath
    }

    const lang = langConfigForPath(filePath)

    return Codeq.fromSource(source, displayPath, lang)
  }

  // --- Output ---

  toSource(): string {
    return this.sourceBytes.toString("utf8")
  }

  /*
   * Atomically write the current source to disk.
   * Uses write-to-temp + rename so concurrent readers never see a partial file.
   */
  async writeFile(filePath?: string): Promise<string> {
    const dest = this.resolveDestination(filePath)
    const dir = dirname(dest)

    mkdirSync(dir, { recursive: true })

    const tmp = join(dir, `.codeq-tmp-${Date.now()}-${Math.random()}`)

    await Bun.write(tmp, this.sourceBytes)

    try {
      await rename(tmp, dest)

    } catch (err) {
      // Clean up temp on failure
      await Bun.file(tmp).exists().then((exists) => {
        if (exists) Bun.file(tmp)
      })

      throw err
    }

    return dest
  }

  // --- Public API ---

  fileMap(): string[] {
    const functions = this.mapFunctions()
    const classes = this.mapClasses()

    const methodsByClass = new Map<string, FunctionMapEntry[]>(
      classes.map((c) => [c.name, []])
    )

    const topLevel: Array<{ offset: number; text: string }> = []

    for (const entry of functions) {
      if (entry.enclosingClass === null) {
        topLevel.push({
          offset: entry.start,
          text: functionSignature(entry),
        })

        continue
      }
      methodsByClass.get(entry.enclosingClass)?.push(entry)
    }

    for (const cls of classes) {
      const methods = (methodsByClass.get(cls.name) ?? []).sort(
        (a, b) => a.start - b.start
      )
      const lines = [
        classSignature(cls),
        ...methods.map((m) =>
          functionSignature(m)
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")
        ),
      ]
      topLevel.push({ offset: cls.start, text: lines.join("\n") })
    }

    const sorted = topLevel.sort((a, b) => a.offset - b.offset)

    if (sorted.length === 0) return []

    const result: string[] = []
    sorted.forEach((item, i) => {
      if (i > 0) result.push("---")
      result.push(item.text)
    })

    return result
  }

  objects(): CodeqObject[] {
    const objs: CodeqObject[] = [
      ...this.mapFunctions().map(functionToResource),
      ...this.mapClasses().map(classToResource),
    ]

    return objs.sort((a, b) => a.metadata.offset - b.metadata.offset)
  }

  addImport(importStmt: string): boolean {
    const statement = importStmt.trim()

    if (!statement) throw new Error("Import statement cannot be empty")

    if (!this.lang.isImportStatement(statement)) {
      throw new Error(`Unsupported import statement: ${JSON.stringify(statement)}`)
    }

    const source = this.sourceBytes.toString("utf8")
    const lines = source.split("\n")

    if (lines.some((l) => l.trim() === statement)) return false

    const insertAt = this.lang.importInsertLine(lines, this.lang.parser)
    lines.splice(insertAt, 0, statement)

    let newSource = lines.join("\n")
    if (source.endsWith("\n") && !newSource.endsWith("\n")) newSource += "\n"

    this.sourceBytes = Buffer.from(newSource, "utf8")
    this.tree = this.lang.parser.parse(newSource)

    return true
  }

  retrieve(
    kind: CodeKind,
    target: string,
    what: CodePart
  ): string | null {
    const captures = this.resolveTargetCaptures(kind, target)

    if (!captures) return null

    switch (what) {
      case CodePart.Node: {
        // const node =
        //   captures.get(`${kind}.decorated_node`)?.[0]
        //   ?? captures.get(`${kind}.node`)?.[0]

        const node = getCaptureKind(captures, kind, 'node')

        return node ? this.decodeNode(node) : null
      }

      case CodePart.Logic: {
        // const body = captures.get(`${kind}.body`)?.[0]
        const body = getCaptureKind(captures, kind, 'body')

        if (!body) return null

        let start = body.startIndex
        // const docNode = captures.get(`${kind}.doc_node`)?.[0]
        const docNode = getCaptureKind(captures, kind, 'doc_node')

        if (docNode) start = docNode.endIndex

        return this.sourceBytes.subarray(start, body.endIndex).toString("utf8").trim()
      }

      default: {
        // const node =
        //   captures.get(`${kind}.${what}`)?.[0]
        //   ?? captures.get(`${kind}.node`)?.[0]
        const node = getCaptureKind(captures, kind, what)

        return node ? this.decodeNode(node) : null
      }
    }
  }

  replace(
    kind: CodeKind,
    target: string,
    what: CodePart,
    newText: string
  ): void {
    const captures = this.resolveTargetCaptures(kind, target)

    if (!captures) {
      throw new TargetNotFoundError(`${kind} '${target}' not found`)
    }

    const { start, end, indentLevel } = this.replacementBounds(
      kind,
      what,
      captures
    )

    // For logic replacements, we splice starting right after the docstring's
    // closing quotes - so we must prepend a newline + indentation ourselves.
    const needsLeadingNewline = what === CodePart.Logic
    const indentPrefix = " ".repeat(indentLevel)
    const prepared =
      (needsLeadingNewline ? `\n${indentPrefix}` : "") + newText

    this.sourceBytes = spliceBuf(
      this.sourceBytes,
      start,
      end,
      Buffer.from(prepared, "utf8")
    )

    this.tree = this.lang.parser.parse(this.sourceBytes.toString("utf8"))
  }

  // --- Query internals ---

  private queryFor(kind: CodeKind): Query {
    return kind === CodeKind.Func ? this.funcsQuery : this.classesQuery
  }

  private matches(
    kind: CodeKind
  ): Array<{ patternIndex: number; captures: CaptureMap }> {
    const raw = this.queryFor(kind).matches(this.tree.rootNode)

    return raw.map((m) => ({
      patternIndex: m.patternIndex,
      captures: toCaptureMap(m.captures),
    }))
  }

  private mapFunctions(): FunctionMapEntry[] {
    const entriesById = new Map<number, FunctionMapEntry>()

    for (const { captures } of this.matches(CodeKind.Func)) {
      const funcNode = captures.get("func.node")?.[0]

      if (!funcNode) continue

      if (entriesById.has(funcNode.id)) continue

      // Skip anonymous functions (e.g. unnamed arrow functions)
      const nameNode = captures.get("func.name")?.[0]
      const paramsNode = captures.get("func.params")?.[0]
      if (!nameNode || !paramsNode) continue

      const decorators: string[] = []
      const decoratedNode = captures.get("func.decorated_node")?.[0]
      if (decoratedNode) {
        for (const child of decoratedNode.children) {
          if (child.type === "decorator") {
            decorators.push(child.text.trim())
          }
        }
      }

      const docstringNode = captures.get("func.docstring")?.[0]
      const docstring = docstringNode
        ? docstringNode.text.replace(/^["']{1,3}|["']{1,3}$/g, "").trim()
        : ""

      entriesById.set(funcNode.id, {
        start: funcNode.startIndex,
        end: funcNode.endIndex,
        name: nameNode.text,
        params: paramsNode.text,
        returnType: captures.get("func.return_type")?.[0]?.text ?? "",
        docstring,
        decorators,
        enclosingClass: this.enclosingClassName(funcNode),
      })
    }

    return [...entriesById.values()]
  }

  private mapClasses(): ClassMapEntry[] {
    const entries: ClassMapEntry[] = []

    for (const { captures } of this.matches(CodeKind.Class)) {
      const classNode = captures.get("class.node")?.[0]

      if (!classNode) continue

      const classNameNode = captures.get("class.name")?.[0]
      if (!classNameNode) continue

      const docNode = captures.get("class.docstring")?.[0]
      entries.push({
        start: classNode.startIndex,
        end: classNode.endIndex,
        name: classNameNode.text,
        superclasses: captures.get("class.superclasses")?.[0]?.text ?? "",
        docstring: docNode
          ? docNode.text.replace(/^["']{1,3}|["']{1,3}$/g, "").trim()
          : "",
      })
    }

    return entries
  }

  private resolveTargetCaptures(
    kind: CodeKind,
    target: string
  ): CaptureMap | null {
    const candidates: Array<{ captures: CaptureMap; fqn: string }> = []

    for (const { captures } of this.matches(kind)) {
      const nameNode = captures.get(`${kind}.name`)?.[0]

      if (!nameNode) continue

      const objName = nameNode.text

      if (kind === CodeKind.Func) {
        const funcNode = captures.get("func.node")?.[0]
        if (!funcNode) continue

        const className = this.enclosingClassName(funcNode)
        const fqn = className ? `${className}.${objName}` : objName

        if (target === fqn || (!target.includes(".") && target === objName)) {
          candidates.push({ captures, fqn })
        }

        continue
      }

      if (target === objName) {
        candidates.push({ captures, fqn: objName })
      }
    }

    if (candidates.length === 0) return null

    if (candidates.length === 1) return candidates[0].captures

    const uniqueFqns = [...new Set(candidates.map((c) => c.fqn))]

    if (uniqueFqns.length === 1) return candidates[0].captures

    throw new AmbiguousTargetError(
      `Ambiguous ${kind} target '${target}'. Matches: ${uniqueFqns.join(", ")}. ` +
      `Use a fully-qualified name, e.g. 'ClassName.method'.`
    )
  }

  private replacementBounds(
    kind: CodeKind,
    part: CodePart,
    captures: CaptureMap
  ): { start: number; end: number; indentLevel: number } {
    if (part === CodePart.Logic) {
      const body = captures.get(`${kind}.body`)?.[0]

      if (!body) {
        throw new MissingCaptureError(`Target found, but ${part} is missing`)
      }

      let start = body.startIndex
      const docNode = captures.get(`${kind}.doc_node`)?.[0]
      if (docNode) start = docNode.endIndex

      return {
        start,
        end: body.endIndex,
        // body indent + 4 for content inside it
        indentLevel: body.startPosition.column,
      }
    }

    const captureName = `${kind}.${part}`
    const targetNodes = captures.get(captureName)

    if (!targetNodes) {
      const available = [...captures.keys()]
        .map((k) => k.split(".")[1])
        .filter(Boolean)

      if (available.includes("body")) available.push("logic")

      throw new MissingCaptureError(
        `Target found, but '${part}' is missing and adding it is unsupported.\n` +
        `Available: ${[...new Set(available)].join(", ")}`
      )
    }

    const node = targetNodes[0]
    return {
      start: node.startIndex,
      end: node.endIndex,
      indentLevel: node.startPosition.column,
    }
  }

  private decodeNode(node: Node): string {
    return this.sourceBytes.subarray(node.startIndex, node.endIndex).toString("utf8")
  }

  private enclosingClassName(node: Node): string | null {
    let current = node.parent
    while (current !== null) {
      if (current.type === "class_definition") {

        return current.childForFieldName("name")?.text ?? null
      }
      current = current.parent
    }

    return null
  }

  private resolveDestination(filePath?: string): string {
    if (filePath) return filePath

    if (this.filePath === "<FILE>") {
      throw new Error(
        "No destination file known for this Codeq instance. Pass filePath explicitly."
      )
    }

    return this.filePath
  }
}

// --- Pure helpers for map entries ---

function getCaptureKind(captures: CaptureMap, kind: string, what: string): Node | undefined {
  return match(what)
    .with('decorated_node', 'node', () => {
      // Prefer decorated_node if present, otherwise node
      return captures.get(`${kind}.decorated_node`)?.[0]
        ?? captures.get(`${kind}.node`)?.[0]
    })
    .otherwise(() => {
      // Fallback to the exact capture by target
      return captures.get(`${kind}.${what}`)?.[0]
    })

}

function functionSignature(e: FunctionMapEntry): string {
  const decoPrefix = e.decorators.length ? e.decorators.join("\n") + "\n" : ""
  const retSuffix = e.returnType ? ` -> ${e.returnType}` : ""
  const docSuffix = e.docstring
    ? `  # ${e.docstring.split(/\s+/).slice(0, 10).join(" ")}`
    : ""

  return `${decoPrefix}def ${e.name}${e.params}${retSuffix}${docSuffix}`
}

function classSignature(e: ClassMapEntry): string {
  const sig = `class ${e.name}${e.superclasses}:`

  return e.docstring
    ? `${sig}  # ${e.docstring.split(/\s+/).slice(0, 10).join(" ")}`
    : sig
}

function functionToResource(e: FunctionMapEntry): CodeqObject {
  return {
    apiVersion: "codeq/v1alpha1",
    kind: ResourceKind.Function,
    metadata: { name: e.name, offset: e.start },
    spec: {
      params: e.params,
      returnType: e.returnType,
      docstring: e.docstring,
      decorators: e.decorators,
    },
  }
}

function classToResource(e: ClassMapEntry): CodeqObject {
  return {
    apiVersion: "codeq/v1alpha1",
    kind: ResourceKind.Class,
    metadata: { name: e.name, offset: e.start },
    spec: { superclasses: e.superclasses, docstring: e.docstring },
  }
}

// --- Quick smoke test (bun run codeq/codeq.ts) ---

if (import.meta.main) {
  const source = `
class Example:
    """Simple example class"""

    @api.path("/protected")
    def baz():
        """
        Cool func
        args: none
        """
        pass

@protected
@api.path("/protected")
@ratelimit(50)
def foo(bar: bool) -> bool:
    """It's so cool function"""
    if bar:
        return True

    return False
`

  const codeq = Codeq.fromSource(source)

  consola.log("=== fileMap ===")
  consola.log(codeq.fileMap().join("\n"))

  consola.log("\n=== replace foo logic ===")
  codeq.replace(CodeKind.Func, "foo", CodePart.Logic, `return not bar`)
  consola.log(codeq.toSource())

  consola.log("\n=== addImport ===")
  const added = codeq.addImport("from jose import jwt")
  consola.log("added:", added)
  consola.log(codeq.toSource())
}
