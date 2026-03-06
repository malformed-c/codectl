/**
 * EventJournal: durable storage layer for the EventBus.
 *
 * All writes go to SQLite via bun:sqlite synchronous API, wrapped in
 * async helpers so the EventBus can await them without blocking.
 */

import { Database } from 'bun:sqlite'
import type { Event, EventStatus } from './models'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  correlation_id TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_topic   ON events(topic);
`

export class EventJournal {
  private readonly db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  async insert(
    topic: string,
    source: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO events (topic, source, payload, created_at, correlation_id, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `)
    const result = stmt.run(topic, source, JSON.stringify(payload), Date.now(), correlationId ?? null)
    return result.lastInsertRowid as number
  }

  /** Atomically claim up to `limit` pending events → 'processing'. */
  async claimPending(limit = 3): Promise<Event[]> {
    const rows = this.db.prepare(`
      SELECT id, topic, source, payload, created_at, correlation_id, status, retry_count
      FROM   events
      WHERE  status = 'pending'
      ORDER  BY id ASC
      LIMIT  ?
    `).all(limit) as any[]

    if (rows.length === 0) return []

    const ids = rows.map(r => r.id)
    this.db.prepare(
      `UPDATE events SET status = 'processing' WHERE id IN (${ids.map(() => '?').join(',')})`
    ).run(...ids)

    return rows.map(r => ({ ...this._rowToEvent(r), status: 'processing' as const }))
  }

  async markDone(id: number): Promise<void> {
    this.db.prepare(`UPDATE events SET status = 'done' WHERE id = ?`).run(id)
  }

  async markRetry(id: number): Promise<void> {
    this.db.prepare(
      `UPDATE events SET status = 'pending', retry_count = retry_count + 1 WHERE id = ?`
    ).run(id)
  }

  async markDeadLetter(id: number, error: string): Promise<void> {
    this.db.prepare(
      `UPDATE events SET status = 'dead_letter', error = ? WHERE id = ?`
    ).run(error, id)
  }

  /** Reset processing → pending (crash recovery on startup). */
  async resetProcessingToPending(): Promise<number> {
    const result = this.db.prepare(
      `UPDATE events SET status = 'pending' WHERE status = 'processing'`
    ).run()
    return result.changes
  }

  /**
   * Watchdog: reset stale 'processing' events back to pending or dead-letter
   * if they've been stuck longer than `staleMs` milliseconds.
   */
  async recoverStale(staleMs: number, maxRetries: number): Promise<[reset: number, dead: number]> {
    const cutoff = Date.now() - staleMs
    const stale = this.db.prepare(`
      SELECT id, retry_count FROM events
      WHERE  status = 'processing' AND created_at < ?
    `).all(cutoff) as any[]

    let reset = 0, dead = 0
    for (const row of stale) {
      if (row.retry_count < maxRetries) {
        this.db.prepare(
          `UPDATE events SET status = 'pending', retry_count = retry_count + 1 WHERE id = ?`
        ).run(row.id)
        reset++
      } else {
        this.db.prepare(
          `UPDATE events SET status = 'dead_letter', error = 'Stale: exceeded max retries' WHERE id = ?`
        ).run(row.id)
        dead++
      }
    }
    return [reset, dead]
  }

  async close(): Promise<void> {
    this.db.close()
  }

  private _rowToEvent(row: any): Event {
    return {
      id:            row.id,
      topic:         row.topic,
      source:        row.source,
      payload:       JSON.parse(row.payload),
      createdAt:     row.created_at,
      correlationId: row.correlation_id ?? undefined,
      status:        row.status as EventStatus,
      retryCount:    row.retry_count,
    }
  }
}
