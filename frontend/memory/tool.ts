import type { ToolDefinition } from '../tool'
import { ok, err } from '../tool'
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
  link    - Create a typed edge between two nodes (temporal|causal|derived_from|entity|supersedes)
  search  - Full-text + graph search, returns top matches with scores
  edges   - Query edges by id, kind, or endpoint node ids
  traverse - Walk the graph from an anchor node and return reachable nodes by hop
  get     - Retrieve a single node by id
  list    - List recent nodes, optionally filtered by kind
  remove  - Soft-delete a node by id

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
        enum: ['add', 'upsert', 'link', 'search', 'edges', 'traverse', 'get', 'list', 'remove'],
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
        enum: ['temporal', 'causal', 'derived_from', 'entity', 'supersedes'],
        description: 'Edge kind (required for link).',
      },
      // search fields
      query:     { type: 'string', description: 'Search query text (required for search).' },
      anchor_id: { type: 'string', description: 'Optional anchor node id for graph-augmented search.' },
      node_id:   { type: 'string', description: 'Node id filter for edges action.' },
      direction: {
        type: 'string',
        enum: ['outbound', 'inbound', 'both'],
        description: 'Traversal direction for traverse/edges node filters (default: outbound for traverse, both for edges).',
      },
      max_hops:  { type: 'string', description: 'Max traversal depth for traverse (default: 2).' },
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

        if (!kind)    return err('"kind" is required for add')

        if (!content) return err('"content" is required for add')

        const tags       = parseTags(args.tags as string | string[] | undefined)
        const confidence = parseFloat(String(args.confidence ?? '1.0'))

        const id = memory.add({ kind, content, tags, confidence })

        return ok({ id})
      }

      case 'upsert': {
        const kind    = args.kind as NodeKind
        const content = args.content as string

        if (!kind)    return err('"kind" is required for upsert')

        if (!content) return err('"content" is required for upsert')

        const tags       = parseTags(args.tags as string | string[] | undefined)
        const confidence = parseFloat(String(args.confidence ?? '1.0'))

        const result = memory.upsert({ kind, content, tags, confidence })

        return ok(result)
      }

      case 'link': {
        const fromId   = args.from_id as string
        const toId     = args.to_id   as string
        const edgeKind = args.edge_kind as EdgeKind

        if (!fromId)   return err('"from_id" is required for link')

        if (!toId)     return err('"to_id" is required for link')

        if (!edgeKind) return err('"edge_kind" is required for link')

        const edgeId = memory.link(fromId, toId, edgeKind)

        return ok({ edge_id: edgeId})
      }

      case 'search': {
        const query = args.query as string

        if (!query) return err('"query" is required for search')

        const anchorId = args.anchor_id as string | undefined
        const limit    = args.limit ? parseInt(String(args.limit), 10) : 8
        const kinds    = args.kind ? [args.kind as NodeKind] : undefined

        const results = memory.search(query, { anchorId, limit, kinds })

        return ok(results.map(r => ({
          id:          r.node.id,
          kind:        r.node.kind,
          content:     r.node.content,
          tags:        r.node.tags,
          confidence:  r.node.confidence,
          score:       Math.round(r.score * 1000) / 1000,
          path_length: r.pathLength,
        })))
      }

      case 'edges': {
        const id = args.id as string | undefined
        const fromId = args.from_id as string | undefined
        const toId = args.to_id as string | undefined
        const nodeId = args.node_id as string | undefined
        const edgeKind = args.edge_kind as EdgeKind | undefined
        const direction = (args.direction as 'outbound' | 'inbound' | 'both' | undefined) ?? 'both'
        const limit = args.limit ? parseInt(String(args.limit), 10) : 20

        const edges = memory.edges({ id, fromId, toId, nodeId, kind: edgeKind, direction, limit })

        return ok(edges.map(e => ({
          id: e.id,
          kind: e.kind,
          from_id: e.fromId,
          to_id: e.toId,
          weight: e.weight,
          created_at: e.createdAt,
        })))
      }

      case 'traverse': {
        const anchorId = (args.anchor_id as string | undefined) ?? (args.id as string | undefined)

        if (!anchorId) return err('"anchor_id" is required for traverse')

        const edgeKinds = args.edge_kind ? [args.edge_kind as EdgeKind] : undefined
        const maxHops = args.max_hops ? parseInt(String(args.max_hops), 10) : 2
        const direction = (args.direction as 'outbound' | 'inbound' | 'both' | undefined) ?? 'outbound'

        const results = memory.traverse(anchorId, { maxHops, edgeKinds, direction })

        return ok(results.map(r => ({
          id: r.node.id,
          kind: r.node.kind,
          content: r.node.content,
          tags: r.node.tags,
          confidence: r.node.confidence,
          score: Math.round(r.score * 1000) / 1000,
          path_length: r.pathLength,
        })))
      }

      case 'get': {
        const id = args.id as string

        if (!id) return err('"id" is required for get')

        const node = memory.get(id)

        if (!node) return err(`Node ${id} not found`)

        return ok(node)
      }

      case 'list': {
        const kind  = args.kind as NodeKind | undefined
        const limit = args.limit ? parseInt(String(args.limit), 10) : 20
        const nodes = memory.list({ kind, limit })

        return ok(nodes.map(n => ({
          id:         n.id,
          kind:       n.kind,
          content:    n.content,
          tags:       n.tags,
          confidence: n.confidence,
        })))
      }

      case 'remove': {
        const id = args.id as string

        if (!id) return err('"id" is required for remove')

        const removed = memory.remove(id)

        if (!removed) return err(`Node ${id} not found`)

        return ok({ removed: id })
      }

      default:
        return err(`Unknown action: ${action}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTags(raw: string | string[] | undefined): string[] {
  if (!raw) return []

  if (Array.isArray(raw)) return raw.map(t => t.trim()).filter(Boolean)
  // Model sometimes passes a JSON array as a string
  const trimmed = raw.trim()

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)

      if (Array.isArray(parsed)) return parsed.map((t: unknown) => String(t).trim()).filter(Boolean)

    } catch { /* fall through to comma-split */ }
  }

  return trimmed.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}
