import type { Orchestrator } from './orchestrator'
import type { Message } from './template'

// --- Types ---

export type RoomMeta = {
  id: string
  createdAt: Date
  updatedAt: Date
  /** Human-readable label, e.g. "auth refactor" */
  label?: string
}

export type Room = {
  meta: RoomMeta
  orchestrator: Orchestrator
}

// --- Factory ---

export function createRoom(id: string, orchestrator: Orchestrator, label?: string): Room {
  const now = new Date()

  return {
    meta: { id, createdAt: now, updatedAt: now, label },
    orchestrator,
  }
}

export function touchRoom(room: Room): void {
  room.meta.updatedAt = new Date()
}

// --- Room registry ---

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>()

  add(room: Room): void {
    this.rooms.set(room.meta.id, room)
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id)
  }

  getOrCreate(id: string, factory: () => Room): Room {
    const existing = this.rooms.get(id)
    if (existing) return existing

    const room = factory()
    this.rooms.set(id, room)

    return room
  }

  delete(id: string): boolean {
    return this.rooms.delete(id)
  }

  list(): RoomMeta[] {
    return [...this.rooms.values()].map((r) => r.meta)
  }

  size(): number {
    return this.rooms.size
  }
}
