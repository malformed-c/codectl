/** A single event record as stored in and read from the journal. */
export type EventStatus = 'pending' | 'processing' | 'done' | 'dead_letter'

export type Event = {
  id: number
  topic: string
  source: string
  payload: Record<string, unknown>
  createdAt: number        // unix timestamp (ms)
  correlationId?: string
  status: EventStatus
  retryCount: number
}

export type EventHandler = (event: Event) => Promise<void>
