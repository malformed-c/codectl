import { join, basename, dirname } from 'node:path'
import { mkdirSync, existsSync, renameSync, readdirSync, rmSync } from 'node:fs'
import type { SerializedRound } from './round'
import { fromJSON, type Round, type History } from './round'
import { VersionedMemory } from './renderer'

// --- Checkpoint type ---

export type Checkpoint = {
  /** Monotonically increasing sequence number. Higher = newer. */
  seq: number

  /** ISO timestamp written at save time. */
  timestamp: string

  /** Serialized round tree - full history at this point. */
  history: SerializedRound[]

  /** Complete memory snapshot (key -> value). */
  memory: Record<string, string>

  /** Mode at checkpoint time, so restoring sessions don't lose context. */
  modeKind: 'chat' | 'agent'

  /**
   * FSM ingest cursor: index into history[] pointing to the first round
   * that has NOT yet been fully committed. Pass 1 resumes from here after restore.
   *
   * For completed sessions (all rounds committed), cursor === history.length.
   */
  cursor: number
}

// --- CheckpointStore ---

/**
 * Writes checkpoints after each committed round boundary.
 * Keeps numbered checkpoint files for history + a `latest.json` pointer.
 *
 * Checkpoint boundaries:
 *   - After a ChatRound is committed (user+model exchange complete)
 *   - After a ToolRound is committed (calls + results paired and stored)
 *   - On graceful shutdown (done tool called or loop exited)
 *
 * Replay never re-executes tools or model calls - it just deserializes the AST.
 */
export class CheckpointStore {
  private readonly dir: string
  private readonly keepRecent: number | undefined
  private _seq = 0

  constructor(checkpointPath: string, keepRecent?: number) {
    this.dir = checkpointPath
    this.keepRecent = keepRecent

    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  get currentSeq(): number { return this._seq }

  private seqPath(seq: number): string {
    return join(this.dir, `checkpoint-${String(seq).padStart(8, '0')}.json`)
  }

  private get latestPath(): string {
    return join(this.dir, 'latest.json')
  }

  /**
   * Write a checkpoint.
   * Call this after every committed round boundary (ToolRound, ChatRound).
   * Writes both a numbered file and atomically updates `latest.json`.
   */
  async save(
    history: History,
    memory: VersionedMemory,
    modeKind: 'chat' | 'agent',
    cursor: number,
  ): Promise<void> {
    const seq = ++this._seq

    const checkpoint: Checkpoint = {
      seq,
      timestamp: new Date().toISOString(),
      history: history.map(r => r.serialize()),
      memory: Object.fromEntries(memory.snapshot()),
      modeKind,
      cursor,
    }

    const json = JSON.stringify(checkpoint, null, 2)

    // Write numbered file first, then overwrite the latest pointer.
    // If the process dies between the two writes, we lose only the `latest` pointer -
    // the numbered file is still intact and can be found via listSeqs().
    await Bun.write(this.seqPath(seq), json)
    await Bun.write(this.latestPath, json)

    if (this.keepRecent !== undefined) {
      await this.prune(this.keepRecent)
    }
  }

  /** Load the latest checkpoint. Returns null if no checkpoint exists (fresh session). */
  async loadLatest(): Promise<Checkpoint | null> {
    const file = Bun.file(this.latestPath)

    if (!(await file.exists())) return null

    try { return await file.json() as Checkpoint }

    catch { return null }
  }

  /** Load a specific checkpoint by sequence number. */
  async loadBySeq(seq: number): Promise<Checkpoint | null> {
    const file = Bun.file(this.seqPath(seq))

    if (!(await file.exists())) return null

    try { return await file.json() as Checkpoint }

    catch { return null }
  }

  /**
   * List all available checkpoint sequence numbers, newest first.
   * Useful for implementing rollback to a specific point.
   */
  async listSeqs(): Promise<number[]> {
    const glob = new Bun.Glob('checkpoint-*.json')
    const seqs: number[] = []

    for await (const file of glob.scan(this.dir)) {
      const m = file.match(/checkpoint-(\d+)\.json$/)

      if (m?.[1]) seqs.push(parseInt(m[1], 10))
    }

    return seqs.sort((a, b) => b - a)
  }

  /**
   * Delete old checkpoint files, keeping the `keep` most recent.
   * Always preserves `latest.json`.
   */
  async prune(keep = 20): Promise<void> {
    const seqs = await this.listSeqs()

    for (const seq of seqs.slice(keep)) {
      await Bun.file(this.seqPath(seq)).delete?.()
    }
  }
  /**
   * Archive the current session before starting a new one.
   *
   * Renames the checkpoint directory to a sibling directory named
   * `<basename>-archive-<timestamp>`, then recreates the original directory
   * empty so the next session starts fresh. Prunes old archives keeping only
   * the most recent `keepArchives` (default 10).
   *
   * Returns the path of the archive directory.
   */
  async archiveSession(keepArchives = 10): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const parent = dirname(this.dir)
    const name = basename(this.dir)
    const archivePath = join(parent, `${name}-archive-${timestamp}`)

    // Rename current dir to archive
    if (existsSync(this.dir)) {
      renameSync(this.dir, archivePath)
    }

    // Recreate fresh checkpoint dir
    mkdirSync(this.dir, { recursive: true })

    // Reset internal sequence counter
    this._seq = 0

    // Prune old archives
    const entries = readdirSync(parent)
    const archives = entries
      .filter(e => e.startsWith(`${name}-archive-`))
      .sort()
      .reverse()

    for (const old of archives.slice(keepArchives)) {
      rmSync(join(parent, old), { recursive: true, force: true })
    }

    return archivePath
  }
}

// --- Replay ---

export type RestoredSession = {
  history: History
  memory: VersionedMemory
  modeKind: 'chat' | 'agent'

  /**
   * FSM cursor: index of the first uncommitted round.
   * Pass 1 FSM should resume ingest from here.
   * For fully committed sessions, cursor === history.length.
   */
  cursor: number
}

/**
 * Restore a session from a checkpoint.
 *
 * No tool re-execution, no model calls - pure AST deserialization.
 * The RenderCache starts empty; it is populated lazily on the first renderHistory() call.
 */
export function replayCheckpoint(cp: Checkpoint): RestoredSession {
  const history: History = cp.history.map(fromJSON)
  const memory = VersionedMemory.fromRecord(cp.memory)

  return {
    history,
    memory,
    modeKind: cp.modeKind,
    cursor: cp.cursor,
  }
}

/**
 * Convenience: load and replay the latest checkpoint.
 * Returns null for fresh sessions with no prior state.
 */
export async function restoreLatest(store: CheckpointStore): Promise<RestoredSession | null> {
  const cp = await store.loadLatest()

  return cp ? replayCheckpoint(cp) : null
}

/**
 * Rollback to a specific checkpoint by sequence number.
 * Useful for recovering from a bad agent run.
 */
export async function rollbackTo(
  store: CheckpointStore,
  seq: number,
): Promise<RestoredSession | null> {
  const cp = await store.loadBySeq(seq)

  return cp ? replayCheckpoint(cp) : null
}
