/**
 * Graph memory store for codectl.
 *
 * Architecture (from yodoca analysis):
 *   - "LLM on Write, Algorithms on Read": writes are cheap SQLite ops; reads use
 *     FTS5 full-text search fused with graph traversal (RRF ranking).
 *   - 4 node types: episodic | semantic | procedural | opinion
 *   - 5 edge types: temporal | causal | derived_from | supersedes | entity
 *   - Conflict resolution: "supersedes" edges soft-delete outdated facts.
 *   - Ebbinghaus decay: confidence × exp(−λ × days^0.8), boosted on access.
 */

import { Database } from 'bun:sqlite'
import { humanId } from 'human-id'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeKind = 'episodic' | 'semantic' | 'procedural' | 'opinion'

export type EdgeKind = 'temporal' | 'causal' | 'derived_from' | 'supersedes' | 'entity'

export type MemoryNode = {
  id: string
  kind: NodeKind
  content: string
  tags: string[]        // free-form labels for entity grouping
  confidence: number    // 0.0 – 1.0
  accessCount: number
  createdAt: number     // unix ms
  lastAccessAt: number  // unix ms
}

export type MemoryEdge = {
  id: string
  kind: EdgeKind
  fromId: string
  toId: string
  weight: number
  createdAt: number
}

export type MemorySearchResult = {
  node: MemoryNode
  score: number
  pathLength?: number   // graph hops from query anchor
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_nodes (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  confidence   REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_access  INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_id) REFERENCES memory_nodes(id),
  FOREIGN KEY (to_id)   REFERENCES memory_nodes(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  node_id UNINDEXED,
  content,
  tags,
  tokenize = 'porter unicode61'
);

CREATE INDEX IF NOT EXISTS idx_edges_from   ON memory_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON memory_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind   ON memory_edges(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON memory_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_access ON memory_nodes(last_access);
`

// ---------------------------------------------------------------------------
// Ebbinghaus decay
// ---------------------------------------------------------------------------

const DECAY_LAMBDA = 0.1
const DECAY_POWER  = 0.8

/**
 * Decayed confidence: confidence × exp(−λ × days^0.8)
 * Access count adds a small boost (up to +0.2).
 */
export function decayedConfidence(
  baseConfidence: number,
  lastAccessMs: number,
  accessCount: number,
  nowMs = Date.now(),
): number {
  const days = Math.max(0, (nowMs - lastAccessMs) / 86_400_000)
  const decayed = baseConfidence * Math.exp(-DECAY_LAMBDA * Math.pow(days, DECAY_POWER))
  const accessBoost = Math.min(0.2, accessCount * 0.02)

  return Math.min(1.0, decayed + accessBoost)
}

// ---------------------------------------------------------------------------
// GraphMemory
// ---------------------------------------------------------------------------

export class GraphMemory {
  private readonly db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /**
   * Generate a unique human-readable ID with collision resistance.
   * Retries on the (astronomically rare) chance the ID already exists.
   */
  private newId(prefix: string): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = `${prefix}:${humanId({ separator: '', capitalize: true })}`
      const table = prefix === 'edge' ? 'memory_edges' : 'memory_nodes'
      const exists = this.db.query<{ id: string }, [string]>(
        `SELECT id FROM ${table} WHERE id = ?`,
      ).get(id)

      if (!exists) return id
    }

    // Fallback: append timestamp to guarantee uniqueness
    return `${prefix}:${humanId({ separator: '', capitalize: true })}${Date.now()}`
  }

  // --- Write ---

  /**
   * Add a new memory node. Returns the node id.
   */
  add(opts: {
    kind:        NodeKind
    content:     string
    tags?:       string[]
    confidence?: number
  }): string {
    const id   = this.newId(opts.kind)
    const now  = Date.now()
    const tags = JSON.stringify(opts.tags ?? [])

    this.db.run(
      `INSERT INTO memory_nodes (id, kind, content, tags, confidence, access_count, created_at, last_access)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, opts.kind, opts.content, tags, opts.confidence ?? 1.0, now, now],
    )

    this.db.run(
      'INSERT INTO memory_fts (node_id, content, tags) VALUES (?, ?, ?)',
      [id, opts.content, (opts.tags ?? []).join(' ')],
    )

    return id
  }

  /**
   * Link two nodes with a typed edge.
   *
   * supersedes: fromId is the NEW fact, toId is the old fact being replaced.
   * The old node is soft-deleted so it no longer appears in searches.
   */
  link(fromId: string, toId: string, kind: EdgeKind, weight = 1.0): string {
    const id  = this.newId('edge')
    const now = Date.now()

    this.db.run(
      `INSERT INTO memory_edges (id, kind, from_id, to_id, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, kind, fromId, toId, weight, now],
    )

    if (kind === 'supersedes') {
      this.db.run('UPDATE memory_nodes SET deleted = 1 WHERE id = ?', [toId])
      this.db.run('DELETE FROM memory_fts WHERE node_id = ?', [toId])
    }

    return id
  }

  /**
   * Upsert a semantic fact: if a non-deleted node with the same kind and at
   * least one overlapping tag exists, supersede it with the new content.
   * Returns { id, superseded: oldId | null }.
   */
  upsert(opts: {
    kind:        NodeKind
    content:     string
    tags?:       string[]
    confidence?: number
  }): { id: string; superseded: string | null } {
    const tags = opts.tags ?? []
    let superseded: string | null = null

    if (tags.length > 0) {
      const existing = this.db.query<{ id: string; tags: string }, [string]>(
        'SELECT id, tags FROM memory_nodes WHERE kind = ? AND deleted = 0',
      ).all(opts.kind)

      for (const row of existing) {
        const existingTags = JSON.parse(row.tags) as string[]

        if (tags.some(t => existingTags.includes(t))) {
          superseded = row.id
          break
        }
      }
    }

    const newNodeId = this.add(opts)

    if (superseded) {
      this.link(newNodeId, superseded, 'supersedes')
    }

    return { id: newNodeId, superseded }
  }

  // --- Read ---

  /**
   * FTS5 full-text search. Returns nodes sorted by BM25 × decay.
   */
  searchFts(query: string, limit = 10): MemorySearchResult[] {
    const now = Date.now()

    type Row = {
      id: string; kind: string; content: string; tags: string
      confidence: number; access_count: number; created_at: number; last_access: number
      bm25: number
    }

    const rows = this.db.query<Row, [string, number]>(
      `SELECT n.id, n.kind, n.content, n.tags, n.confidence, n.access_count,
              n.created_at, n.last_access, -bm25(memory_fts) as bm25
       FROM memory_fts f
       JOIN memory_nodes n ON n.id = f.node_id
       WHERE memory_fts MATCH ? AND n.deleted = 0
       ORDER BY bm25 DESC
       LIMIT ?`,
    ).all(query, limit)

    return rows.map(r => ({
      node:  this._rowToNode(r),
      score: r.bm25 * decayedConfidence(r.confidence, r.last_access, r.access_count, now),
    }))
  }

  /**
   * Graph BFS from an anchor node id, up to maxHops.
   * Excludes 'supersedes' edges by default (those are conflict-resolution edges,
   * not semantic links). Returns reachable non-deleted nodes with hop distance.
   */
  traverse(
    anchorId: string,
    opts: { maxHops?: number; edgeKinds?: EdgeKind[] } = {},
  ): MemorySearchResult[] {
    const maxHops = opts.maxHops ?? 2
    const kinds   = opts.edgeKinds ?? (['temporal', 'causal', 'derived_from', 'entity'] as EdgeKind[])
    const visited = new Map<string, number>()
    const queue: Array<{ id: string; hop: number }> = [{ id: anchorId, hop: 0 }]

    while (queue.length > 0) {
      const item = queue.shift()!

      if (visited.has(item.id) || item.hop > maxHops) continue
      visited.set(item.id, item.hop)

      if (item.hop < maxHops) {
        const placeholders = kinds.map(() => '?').join(', ')
        const neighbors = this.db.query<{ to_id: string }, any[]>(
          `SELECT to_id FROM memory_edges WHERE from_id = ? AND kind IN (${placeholders})`,
        ).all(item.id as any, ...(kinds as any[]))

        for (const n of neighbors) queue.push({ id: n.to_id, hop: item.hop + 1 })
      }
    }

    visited.delete(anchorId)

    if (visited.size === 0) return []

    const ids = [...visited.keys()]
    const placeholders = ids.map(() => '?').join(', ')

    type NodeRow = {
      id: string; kind: string; content: string; tags: string
      confidence: number; access_count: number; created_at: number; last_access: number
    }

    const nodes = this.db.query<NodeRow, any[]>(
      `SELECT id, kind, content, tags, confidence, access_count, created_at, last_access
       FROM memory_nodes WHERE id IN (${placeholders}) AND deleted = 0`,
    ).all(...(ids as any[]))

    const now = Date.now()

    return nodes.map(r => ({
      node:       this._rowToNode(r),
      score:      decayedConfidence(r.confidence, r.last_access, r.access_count, now),
      pathLength: visited.get(r.id),
    }))
  }

  /**
   * Fused search: RRF combination of FTS5 and graph traversal.
   * RRF formula: Σ 1/(k + rank_i) with k=60.
   * Graph results require an anchorId.
   */
  search(
    query: string,
    opts: { anchorId?: string; limit?: number; kinds?: NodeKind[] } = {},
  ): MemorySearchResult[] {
    const limit   = opts.limit ?? 8
    const ftsHits = this.searchFts(query, limit * 2)
    const merged  = new Map<string, { node: MemoryNode; scores: number[] }>()

    ftsHits.forEach((r, rank) => {
      merged.set(r.node.id, { node: r.node, scores: [1 / (60 + rank)] })
    })

    if (opts.anchorId) {
      this.traverse(opts.anchorId, { maxHops: 2 }).forEach((r, rank) => {
        const entry = merged.get(r.node.id)
        const s = 1 / (60 + rank)

        if (entry) entry.scores.push(s)
        else merged.set(r.node.id, { node: r.node, scores: [s] })
      })
    }

    let results = [...merged.values()].map(({ node, scores }) => ({
      node,
      score: scores.reduce((a, b) => a + b, 0),
    }))

    if (opts.kinds?.length) {
      results = results.filter(r => opts.kinds!.includes(r.node.kind as NodeKind))
    }

    results.sort((a, b) => b.score - a.score)

    // Stamp access on returned nodes
    const topIds = results.slice(0, limit).map(r => r.node.id)

    if (topIds.length > 0) {
      const now = Date.now()
      const placeholders = topIds.map(() => '?').join(', ')
      this.db.run(
        `UPDATE memory_nodes SET access_count = access_count + 1, last_access = ?
         WHERE id IN (${placeholders})`,
        [now, ...topIds],
      )
    }

    return results.slice(0, limit)
  }

  /**
   * Soft-delete a node by id. Also removes it from the FTS index.
   * Returns true if the node existed and was deleted, false if not found.
   */
  remove(id: string): boolean {
    const existing = this.db.query<{ id: string }, [string]>(
      'SELECT id FROM memory_nodes WHERE id = ? AND deleted = 0',
    ).get(id)

    if (!existing) return false

    this.db.run('UPDATE memory_nodes SET deleted = 1 WHERE id = ?', [id])
    this.db.run('DELETE FROM memory_fts WHERE node_id = ?', [id])

    return true
  }

  /** Get a single node by id. Returns null if not found or deleted. */
  get(id: string): MemoryNode | null {
    type NodeRow = {
      id: string; kind: string; content: string; tags: string
      confidence: number; access_count: number; created_at: number; last_access: number
    }

    const row = this.db.query<NodeRow, [string]>(
      `SELECT id, kind, content, tags, confidence, access_count, created_at, last_access
       FROM memory_nodes WHERE id = ? AND deleted = 0`,
    ).get(id)

    return row ? this._rowToNode(row) : null
  }

  /** List non-deleted nodes, newest first. */
  list(opts: { kind?: NodeKind; limit?: number } = {}): MemoryNode[] {
    const limit = opts.limit ?? 50

    type NodeRow = {
      id: string; kind: string; content: string; tags: string
      confidence: number; access_count: number; created_at: number; last_access: number
    }

    if (opts.kind) {
      return this.db.query<NodeRow, [string, number]>(
        `SELECT id, kind, content, tags, confidence, access_count, created_at, last_access
         FROM memory_nodes WHERE kind = ? AND deleted = 0
         ORDER BY created_at DESC LIMIT ?`,
      ).all(opts.kind, limit).map(r => this._rowToNode(r))
    }

    return this.db.query<NodeRow, [number]>(
      `SELECT id, kind, content, tags, confidence, access_count, created_at, last_access
       FROM memory_nodes WHERE deleted = 0
       ORDER BY created_at DESC LIMIT ?`,
    ).all(limit).map(r => this._rowToNode(r))
  }

  /**
   * Apply Ebbinghaus decay to nodes older than ageDays.
   * Nodes with decayed confidence < pruneBelow are soft-deleted.
   * Returns the number of pruned nodes.
   */
  runDecayAndPrune(opts: { ageDays?: number; pruneBelow?: number } = {}): number {
    const ageDays   = opts.ageDays   ?? 1
    const threshold = opts.pruneBelow ?? 0.05
    const cutoffMs  = Date.now() - ageDays * 86_400_000
    const now       = Date.now()

    type StaleRow = { id: string; confidence: number; access_count: number; last_access: number }

    const stale = this.db.query<StaleRow, [number]>(
      `SELECT id, confidence, access_count, last_access
       FROM memory_nodes WHERE last_access < ? AND deleted = 0`,
    ).all(cutoffMs)

    let pruned = 0

    for (const r of stale) {
      const decayed = decayedConfidence(r.confidence, r.last_access, r.access_count, now)

      if (decayed < threshold) {
        this.db.run('UPDATE memory_nodes SET deleted = 1 WHERE id = ?', [r.id])
        this.db.run('DELETE FROM memory_fts WHERE node_id = ?', [r.id])
        pruned++
      } else {
        this.db.run('UPDATE memory_nodes SET confidence = ? WHERE id = ?', [decayed, r.id])
      }
    }

    return pruned
  }

  // ---------------------------------------------------------------------------
  // Prompt recall
  // ---------------------------------------------------------------------------

  /**
   * Search for nodes relevant to `query` and return a compact formatted string
   * suitable for injecting into the model prompt as a system context block.
   *
   * Returns an empty string when the store has no relevant results, so callers
   * can skip injection without special-casing.
   */
  recallForPrompt(query: string, limit = 5): string {
    let results: MemorySearchResult[]

    try {
      results = this.search(query, { limit })
    } catch {
      // FTS can throw on malformed queries (e.g. bare operators); degrade gracefully
      return ''
    }

    if (results.length === 0) return ''

    const lines = results.map(({ node, score }) => {
      const conf = score.toFixed(2)
      const tags = node.tags.length ? ` [${node.tags.join(', ')}]` : ''

      return `• (${node.kind}, conf ${conf})${tags} ${node.content}`
    })

    return `[Recalled memory]\n${lines.join('\n')}`
  }

  // --- Internal ---

  private _rowToNode(r: {
    id: string; kind: string; content: string; tags: string
    confidence: number; access_count: number; created_at: number; last_access: number
  }): MemoryNode {
    return {
      id:           r.id,
      kind:         r.kind as NodeKind,
      content:      r.content,
      tags:         JSON.parse(r.tags) as string[],
      confidence:   r.confidence,
      accessCount:  r.access_count,
      createdAt:    r.created_at,
      lastAccessAt: r.last_access,
    }
  }
}
