import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import type { Message } from './template'
import type { RoomMeta } from './room'

// --- Types ---

export type PersistedRoom = {
  meta: RoomMeta
  history: Message[]
}

// --- History store ---

export class HistoryStore {
  private readonly dir: string

  constructor(historyPath: string) {
    this.dir = historyPath
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private filePath(roomId: string): string {
    return join(this.dir, `${roomId}.json`)
  }

  async save(meta: RoomMeta, history: Message[]): Promise<void> {
    const data: PersistedRoom = { meta, history }

    await Bun.write(this.filePath(meta.id), JSON.stringify(data, null, 2))
  }

  async load(roomId: string): Promise<PersistedRoom | null> {
    const file = Bun.file(this.filePath(roomId))

    if (!(await file.exists())) return null

    try {
      return await file.json() as PersistedRoom

    } catch {
      return null
    }
  }

  async delete(roomId: string): Promise<void> {
    const path = this.filePath(roomId)

    if (existsSync(path)) await Bun.file(path).delete?.()
  }

  async list(): Promise<RoomMeta[]> {
    const glob = new Bun.Glob('*.json')
    const metas: RoomMeta[] = []

    for await (const file of glob.scan(this.dir)) {
      const roomId = file.replace(/\.json$/, '')

      const persisted = await this.load(roomId)

      if (persisted) metas.push(persisted.meta)
    }

    return metas.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }
}
