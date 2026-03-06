import type { ToolDefinition } from '../tool'
import type { ToolHandler } from '../orchestrator'
import type { GraphMemory, NodeKind, EdgeKind } from './graph'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const GraphMemoryTool: ToolDefinition = {
  name: 'memory_graph',
  description: `Persistent graph memory with semantic search. Use this for information that matters across sessions.

Actions:
  add     - Store a new memory node (kind: episodic|semantic|procedural|opinion)
  upsert  - Store a fact, superseding any existing node with the same kind+tags
  link    - Create a typed edge between two nodes (temporal|causal|derived_from|entity)
  search  - Full-text + graph search, returns top matches with scores
  get     - Retrieve a single node by id
  list    - List recent nodes, optionally filtered by kind

Node kinds:
  episodic   - Specific events or observations ("User mentioned they prefer TypeScript")
  semantic   - General facts ("The project uses Bun as runtime")
  procedural - How-to knowledge ("To run tests: bun test")
  opinion    - User preferences or judgments ("User dislikes verbose output")

Edge kinds:
  temporal     - One event followed another
  causal       - One node caused or explains another
  derived_from - One node was inferred from another
  entity       - Both nodes refer to the same entity (grouping)`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'upsert', 'link', 'search', 'get', 'list'],
        description: 'Action to perform.',
      },
      // add / upsert fields
      kind: {
        type: 'string',
        enum: ['episodic', 'semantic', 'procedural', 'opinion'],
        description: 'Node kind (required for add/upsert).',
      },
      content: {
        type: 'string',
        description: 'Text content to store (required for add/upsert).',
      },
      tags: {
        type: 'string',
        description: 'Comma-separated entity tags, e.g. "user,preferences" (optional).',
      },
      confidence: {
        type: 'string',
        description: 'Initial confidence 0.0–1.0 (default: 1.0).',
      },
      // link fields
      from_id: { type: 'string', description: 'Source node id (required for link).' },
      to_id:   { type: 'string', description: 'Target node id (required for link).' },
      edge_kind: {
        type: 'string',
        enum: ['temporal', 'causal', 'derived_from', 'entity'],
        description: 'Edge kind (required for link).',
      },
      // search fields
      query:     { type: 'string', description: 'Search query text (required for search).' },
      anchor_id: { type: 'string', description: 'Optional anchor node id for graph-augmented search.' },
      limit:     { type: 'string', description: 'Max results to return (default: 8).' },
      // get / list fields
      id:        { type: 'string', description: 'Node id (required for get).' },
    },
    required: ['action'],
  },
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createGraphMemoryHandler(memory: GraphMemory): ToolHandler {
  return async (args) => {
    const action = args.action as string

    switch (action) {
      case 'add': {
        const kind    = args.kind as NodeKind
        const content = args.content as string
        if (!kind)    return { result: null, error: '"kind" is required for add' }
        if (!content) return { result: null, error: '"content" is required for add' }

        const tags       = parseTags(args.tags as string | undefined)
        const confidence = parseFloat(String(args.confidence ?? '1.0'))

        const id = memory.add({ kind, content, tags, confidence })
        return { result: { id } }
      }

      case 'upsert': {
        const kind    = args.kind as NodeKind
        const content = args.content as string
        if (!kind)    return { result: null, error: '"kind" is required for upsert' }
        if (!content) return { result: null, error: '"content" is required for upsert' }

        const tags       = parseTags(args.tags as string | undefined)
        const confidence = parseFloat(String(args.confidence ?? '1.0'))

        const result = memory.upsert({ kind, content, tags, confidence })
        return { result }
      }

      case 'link': {
        const fromId   = args.from_id as string
        const toId     = args.to_id   as string
        const edgeKind = args.edge_kind as EdgeKind
        if (!fromId)   return { result: null, error: '"from_id" is required for link' }
        if (!toId)     return { result: null, error: '"to_id" is required for link' }
        if (!edgeKind) return { result: null, error: '"edge_kind" is required for link' }

        const edgeId = memory.link(fromId, toId, edgeKind)
        return { result: { edge_id: edgeId } }
      }

      case 'search': {
        const query = args.query as string
        if (!query) return { result: null, error: '"query" is required for search' }

        const anchorId = args.anchor_id as string | undefined
        const limit    = args.limit ? parseInt(String(args.limit), 10) : 8
        const kinds    = args.kind ? [args.kind as NodeKind] : undefined

        const results = memory.search(query, { anchorId, limit, kinds })
        return {
          result: results.map(r => ({
            id:          r.node.id,
            kind:        r.node.kind,
            content:     r.node.content,
            tags:        r.node.tags,
            confidence:  r.node.confidence,
            score:       Math.round(r.score * 1000) / 1000,
            path_length: r.pathLength,
          })),
        }
      }

      case 'get': {
        const id = args.id as string
        if (!id) return { result: null, error: '"id" is required for get' }

        const node = memory.get(id)
        if (!node) return { result: null, error: `Node ${id} not found` }
        return { result: node }
      }

      case 'list': {
        const kind  = args.kind as NodeKind | undefined
        const limit = args.limit ? parseInt(String(args.limit), 10) : 20
        const nodes = memory.list({ kind, limit })
        return {
          result: nodes.map(n => ({
            id:         n.id,
            kind:       n.kind,
            content:    n.content,
            tags:       n.tags,
            confidence: n.confidence,
          })),
        }
      }

      default:
        return { result: null, error: `Unknown action: ${action}` }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTags(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(t => t.trim()).filter(Boolean)
}
