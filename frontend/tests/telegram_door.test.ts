import { describe, expect, test } from 'bun:test'
import { checkpointDirForChat, roomIdForChat } from '../door/telegram'

describe('Telegram room/checkpoint mapping', () => {
  test('maps the same chat id to a stable room id and checkpoint path', () => {
    const chatId = 123456

    expect(roomIdForChat(chatId)).toBe('telegram-123456')
    expect(checkpointDirForChat('./checkpoints', chatId)).toBe('checkpoints/telegram-123456')
    expect(checkpointDirForChat('./checkpoints', chatId)).toBe(checkpointDirForChat('./checkpoints', chatId))
  })

  test('isolates different chats into different checkpoint paths', () => {
    expect(checkpointDirForChat('./checkpoints', 1)).toBe('checkpoints/telegram-1')
    expect(checkpointDirForChat('./checkpoints', 2)).toBe('checkpoints/telegram-2')
    expect(checkpointDirForChat('./checkpoints', 1)).not.toBe(checkpointDirForChat('./checkpoints', 2))
  })

  test('disables checkpointing cleanly when root is omitted', () => {
    expect(checkpointDirForChat(undefined, 42)).toBeUndefined()
  })
})
