import { join } from 'path'
import { mkdir } from 'fs/promises'
import { History, Message } from './messages'

export class HistoryManager {
  private historyPath: string

  constructor(historyPath: string) {
    this.historyPath = historyPath
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.historyPath, { recursive: true })
  }

  async load(id: string): Promise<History> {
    const filePath = join(this.historyPath, `${id}.json`)
    const file = Bun.file(filePath)

    if (!(await file.exists())) {
      return { id, messages: [] }
    }

    return await file.json() as History
  }

  async save(history: History): Promise<void> {
    await this.ensureDirectory()
    const filePath = join(this.historyPath, `${history.id}.json`)
    await Bun.write(filePath, JSON.stringify(history, null, 2))
  }

  addMessage(history: History, message: Message): History {
    return {
      ...history,
      messages: [...history.messages, message]
    }
  }
}
