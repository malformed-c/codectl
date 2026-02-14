import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { History, Message } from './messages'

export class HistoryManager {
  private historyPath: string

  constructor(historyPath: string) {
    this.historyPath = historyPath
    if (!existsSync(this.historyPath)) {
      mkdirSync(this.historyPath, { recursive: true })
    }
  }

  load(id: string): History {
    const filePath = join(this.historyPath, `${id}.json`)
    if (!existsSync(filePath)) {
      return { id, messages: [] }
    }
    const content = readFileSync(filePath, 'utf8')
    return JSON.parse(content) as History
  }

  save(history: History): void {
    const filePath = join(this.historyPath, `${history.id}.json`)
    writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8')
  }

  addMessage(history: History, message: Message): History {
    return {
      ...history,
      messages: [...history.messages, message]
    }
  }
}
