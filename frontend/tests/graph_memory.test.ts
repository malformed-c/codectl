import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { GraphMemory, decayedConfidence } from '../memory/graph'
import type { NodeKind } from '../memory/graph'
import { unlinkSync, existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/test_graph_memory.db'

function freshDb(): GraphMemory {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH)

  return new GraphMemory(DB_PATH)
}

// ---------------------------------------------------------------------------
// Ebbinghaus decay
// ---------------------------------------------------------------------------

describe('decayedConfidence', () => {
  test('returns full confidence at t=0', () => {
    const now = Date.now()
    expect(decayedConfidence(1.0, now, 0, now)).toBeCloseTo(1.0, 3)
  })

  test('decays over time', () => {
    const now  = Date.now()
    const past = now - 10 * 86_400_000  // 10 days ago
    const d    = decayedConfidence(1.0, past, 0, now)
    expect(d).toBeLessThan(0.9)
    expect(d).toBeGreaterThan(0.0)
  })

  test('access count boosts confidence', () => {
    const now  = Date.now()
    const past = now - 7 * 86_400_000
    const low  = decayedConfidence(1.0, past, 0, now)
    const high = decayedConfidence(1.0, past, 10, now)
    expect(high).toBeGreaterThan(low)
  })

  test('never exceeds 1.0', () => {
    const now = Date.now()
    expect(decayedConfidence(0.99, now, 100, now)).toBeLessThanOrEqual(1.0)
  })
})

// ---------------------------------------------------------------------------
// GraphMemory - basic CRUD
// ---------------------------------------------------------------------------

describe('GraphMemory - add / get', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('add returns an id', () => {
    const id = gm.add({ kind: 'semantic', content: 'The project uses Bun.' })
    expect(id).toBeTypeOf('string')
    expect(id.length).toBeGreaterThan(0)
  })

  test('get returns the stored node', () => {
    const id = gm.add({ kind: 'semantic', content: 'Bun is the runtime.', tags: ['runtime'] })
    const node = gm.get(id)
    expect(node).not.toBeNull()
    expect(node!.content).toBe('Bun is the runtime.')
    expect(node!.kind).toBe('semantic')
    expect(node!.tags).toContain('runtime')
    expect(node!.confidence).toBe(1.0)
  })

  test('get returns null for unknown id', () => {
    expect(gm.get('nonexistent')).toBeNull()
  })

  test('list returns all non-deleted nodes', () => {
    gm.add({ kind: 'episodic', content: 'A' })
    gm.add({ kind: 'semantic', content: 'B' })
    gm.add({ kind: 'procedural', content: 'C' })
    expect(gm.list()).toHaveLength(3)
  })

  test('list filters by kind', () => {
    gm.add({ kind: 'episodic', content: 'event' })
    gm.add({ kind: 'semantic', content: 'fact' })
    const episodic = gm.list({ kind: 'episodic' })
    expect(episodic).toHaveLength(1)
    expect(episodic[0]!.kind).toBe('episodic')
  })
})

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe('GraphMemory - edges', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('link creates an edge', () => {
    const a = gm.add({ kind: 'episodic', content: 'First event' })
    const b = gm.add({ kind: 'episodic', content: 'Second event' })
    const edgeId = gm.link(a, b, 'temporal')
    expect(edgeId).toBeTypeOf('string')
  })

  test('supersedes edge soft-deletes the old node', () => {
    const old = gm.add({ kind: 'semantic', content: 'I work at Acme.' })
    const fresh = gm.add({ kind: 'semantic', content: 'I work at Globex.' })
    gm.link(fresh, old, 'supersedes')

    expect(gm.get(old)).toBeNull()    // old is gone
    expect(gm.get(fresh)).not.toBeNull()  // new is still there
  })
})

// ---------------------------------------------------------------------------
// Upsert / conflict resolution
// ---------------------------------------------------------------------------

describe('GraphMemory - upsert', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('upsert without matching node just adds', () => {
    const { id, superseded } = gm.upsert({ kind: 'semantic', content: 'Sky is blue.', tags: ['sky'] })
    expect(id).toBeTypeOf('string')
    expect(superseded).toBeNull()
    expect(gm.list()).toHaveLength(1)
  })

  test('upsert with overlapping tags supersedes old node', () => {
    const { id: oldId } = gm.upsert({ kind: 'opinion', content: 'Prefers dark mode.', tags: ['user', 'ui'] })
    const { id: newId, superseded } = gm.upsert({ kind: 'opinion', content: 'Prefers light mode.', tags: ['user', 'ui'] })

    expect(superseded).toBe(oldId)
    expect(gm.get(oldId)).toBeNull()   // soft-deleted
    expect(gm.get(newId)).not.toBeNull()

    const all = gm.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.content).toBe('Prefers light mode.')
  })

  test('upsert without tags never supersedes', () => {
    gm.upsert({ kind: 'semantic', content: 'Fact A.' })
    const { superseded } = gm.upsert({ kind: 'semantic', content: 'Fact B.' })
    expect(superseded).toBeNull()
    expect(gm.list()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// FTS search
// ---------------------------------------------------------------------------

describe('GraphMemory - searchFts', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('finds nodes by keyword', () => {
    gm.add({ kind: 'semantic', content: 'TypeScript is a typed superset of JavaScript.' })
    gm.add({ kind: 'semantic', content: 'Bun is a JavaScript runtime.' })
    gm.add({ kind: 'semantic', content: 'SQLite is an embedded database.' })

    const results = gm.searchFts('JavaScript')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(r => r.node.content.includes('JavaScript'))).toBe(true)
  })

  test('returns scores > 0', () => {
    gm.add({ kind: 'procedural', content: 'Run tests with bun test.' })
    const results = gm.searchFts('bun test')
    expect(results[0]!.score).toBeGreaterThan(0)
  })

  test('does not return deleted nodes', () => {
    const id = gm.add({ kind: 'semantic', content: 'This should be deleted.' })
    const fresh = gm.add({ kind: 'semantic', content: 'Replacement.' })
    gm.link(fresh, id, 'supersedes')

    const results = gm.searchFts('deleted')
    expect(results.every(r => r.node.id !== id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

describe('GraphMemory - traverse', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('traverses edges to find related nodes', () => {
    const a = gm.add({ kind: 'episodic', content: 'Event A' })
    const b = gm.add({ kind: 'episodic', content: 'Event B' })
    const c = gm.add({ kind: 'episodic', content: 'Event C' })
    gm.link(a, b, 'temporal')
    gm.link(b, c, 'temporal')

    const results = gm.traverse(a, { maxHops: 2 })
    const ids = results.map(r => r.node.id)
    expect(ids).toContain(b)
    expect(ids).toContain(c)
  })

  test('respects maxHops limit', () => {
    const a = gm.add({ kind: 'episodic', content: 'A' })
    const b = gm.add({ kind: 'episodic', content: 'B' })
    const c = gm.add({ kind: 'episodic', content: 'C' })
    gm.link(a, b, 'temporal')
    gm.link(b, c, 'temporal')

    const one_hop = gm.traverse(a, { maxHops: 1 })
    const ids = one_hop.map(r => r.node.id)
    expect(ids).toContain(b)
    expect(ids).not.toContain(c)
  })

  test('returns pathLength for each result', () => {
    const a = gm.add({ kind: 'semantic', content: 'A' })
    const b = gm.add({ kind: 'semantic', content: 'B' })
    gm.link(a, b, 'entity')

    const results = gm.traverse(a)
    const bResult = results.find(r => r.node.id === b)
    expect(bResult?.pathLength).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Fused RRF search
// ---------------------------------------------------------------------------

describe('GraphMemory - search (RRF)', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('returns results sorted by score descending', () => {
    gm.add({ kind: 'semantic', content: 'TypeScript strongly typed language.' })
    gm.add({ kind: 'semantic', content: 'Unrelated content about cooking.' })
    gm.add({ kind: 'semantic', content: 'TypeScript compiler checks types.' })

    const results = gm.search('TypeScript')

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score)
    }
  })

  test('fuses graph results with FTS when anchorId provided', () => {
    const anchor = gm.add({ kind: 'semantic', content: 'TypeScript project setup.' })
    const related = gm.add({ kind: 'procedural', content: 'Install dependencies with bun install.' })
    gm.link(anchor, related, 'causal')
    gm.add({ kind: 'episodic', content: 'User asked about cooking.' })

    const results = gm.search('project', { anchorId: anchor })
    // The related node should appear even though 'project' doesn't match it directly
    const ids = results.map(r => r.node.id)
    expect(ids).toContain(related)
  })

  test('filters by kind when specified', () => {
    gm.add({ kind: 'semantic', content: 'TypeScript facts.' })
    gm.add({ kind: 'episodic', content: 'TypeScript event.' })

    const results = gm.search('TypeScript', { kinds: ['semantic'] })
    expect(results.every(r => r.node.kind === 'semantic')).toBe(true)
  })

  test('stamps access on returned nodes', () => {
    const id = gm.add({ kind: 'semantic', content: 'Accessible content here.' })
    gm.search('Accessible content')

    const node = gm.get(id)
    expect(node!.accessCount).toBe(1)
  })

  test('finds nodes by id fragment when query is not in content', () => {
    const id = gm.add({ kind: 'episodic', content: 'Edge traversal test memory.' })
    const suffix = id.split(':')[1]!
    const results = gm.search(suffix)

    expect(results.some(r => r.node.id === id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Decay + prune
// ---------------------------------------------------------------------------

describe('GraphMemory - runDecayAndPrune', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => gm.close())

  test('prunes nodes with confidence below threshold', () => {
    // Add a node and backdate its last_access to far in the past
    const id = gm.add({ kind: 'episodic', content: 'Ancient event.' })
    const ancient = Date.now() - 365 * 86_400_000   // 1 year ago
    // Directly update last_access via the DB
    ;(gm as any).db.run('UPDATE memory_nodes SET last_access = ? WHERE id = ?', [ancient, id])
    ;(gm as any).db.run('UPDATE memory_nodes SET created_at = ? WHERE id = ?', [ancient, id])

    const pruned = gm.runDecayAndPrune({ ageDays: 1, pruneBelow: 0.5 })
    expect(pruned).toBe(1)
    expect(gm.get(id)).toBeNull()
  })

  test('keeps fresh nodes', () => {
    const id = gm.add({ kind: 'semantic', content: 'Recent fact.' })
    const pruned = gm.runDecayAndPrune({ ageDays: 30, pruneBelow: 0.05 })
    expect(pruned).toBe(0)
    expect(gm.get(id)).not.toBeNull()
  })
})

describe('GraphMemory - remove', () => {
  let gm: GraphMemory
  beforeEach(() => { gm = freshDb() })
  afterEach(() => { gm.close() })

  test('remove soft-deletes a node', () => {
    const id = gm.add({ kind: 'semantic', content: 'to be removed' })
    expect(gm.get(id)).not.toBeNull()
    expect(gm.remove(id)).toBe(true)
    expect(gm.get(id)).toBeNull()
  })

  test('remove returns false for unknown id', () => {
    expect(gm.remove('nonexistent:FakeId')).toBe(false)
  })

  test('removed node does not appear in search', () => {
    const id = gm.add({ kind: 'semantic', content: 'unique pineapple content' })
    gm.remove(id)
    const results = gm.searchFts('pineapple')
    expect(results.find(r => r.node.id === id)).toBeUndefined()
  })

  test('removed node does not appear in list', () => {
    const id = gm.add({ kind: 'semantic', content: 'to be listed then removed' })
    expect(gm.list().find(n => n.id === id)).toBeDefined()
    gm.remove(id)
    expect(gm.list().find(n => n.id === id)).toBeUndefined()
  })
})

describe('GraphMemory - ID collision resistance', () => {
  let gm: GraphMemory

  beforeEach(() => { gm = freshDb() })
  afterEach(() => {
 gm.close()

 if (existsSync(DB_PATH)) unlinkSync(DB_PATH) 
})

  test('bulk inserts produce no duplicate IDs', () => {
    const ids = Array.from({ length: 200 }, (_, i) =>
      gm.add({ kind: 'episodic', content: `event ${i}` })
    )
    const unique = new Set(ids)
    expect(unique.size).toBe(200)
  })

  test('edge IDs are unique across many links', () => {
    const a = gm.add({ kind: 'semantic', content: 'node a' })
    const b = gm.add({ kind: 'semantic', content: 'node b' })
    const c = gm.add({ kind: 'semantic', content: 'node c' })
    const edgeIds = [
      gm.link(a, b, 'causal'),
      gm.link(b, c, 'temporal'),
      gm.link(a, c, 'derived_from'),
    ]
    expect(new Set(edgeIds).size).toBe(3)
  })

  test('node and edge IDs never collide with each other', () => {
    const nodeIds = Array.from({ length: 50 }, (_, i) =>
      gm.add({ kind: 'procedural', content: `step ${i}` })
    )
    // Link each consecutive pair
    const edgeIds: string[] = []

    for (let i = 0; i < nodeIds.length - 1; i++) {
      edgeIds.push(gm.link(nodeIds[i]!, nodeIds[i + 1]!, 'temporal'))
    }
    const all = [...nodeIds, ...edgeIds]
    expect(new Set(all).size).toBe(all.length)
  })
})
