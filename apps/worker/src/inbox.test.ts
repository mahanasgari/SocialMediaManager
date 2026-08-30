import { describe, expect, it } from 'vitest'
import { conversationUpdate } from './inbox.js'

const noon = new Date('2026-08-30T12:00:00Z')

describe('conversationUpdate', () => {
  it('advances lastMessageAt for a newer message', () => {
    const later = new Date('2026-08-30T12:05:00Z')
    const update = conversationUpdate({ lastMessageAt: noon, status: 'OPEN' }, later)
    expect(update.lastMessageAt).toEqual(later)
  })

  it('does NOT move lastMessageAt backwards for a late arrival', () => {
    // The rule the whole function exists for. Webhooks arrive out of order
    // routinely; the inbox sorts on this column, so writing an older timestamp
    // would drag an active thread down the list and make it look abandoned.
    const earlier = new Date('2026-08-30T11:00:00Z')
    const update = conversationUpdate({ lastMessageAt: noon, status: 'OPEN' }, earlier)
    expect(update.lastMessageAt).toBeUndefined()
  })

  it('leaves it alone for an identical timestamp', () => {
    // Two messages in the same second is a redelivery or a genuine burst.
    // Either way there is nothing to advance.
    expect(conversationUpdate({ lastMessageAt: noon, status: 'OPEN' }, noon).lastMessageAt).toBeUndefined()
  })

  it('still counts a late message as unread', () => {
    const earlier = new Date('2026-08-30T11:00:00Z')
    const update = conversationUpdate({ lastMessageAt: noon, status: 'OPEN' }, earlier)
    expect(update.unreadCount).toEqual({ increment: 1 })
  })

  it('reopens an archived conversation', () => {
    // Someone replying to a closed thread is exactly where staying archived
    // loses the message.
    const update = conversationUpdate({ lastMessageAt: noon, status: 'ARCHIVED' }, new Date())
    expect(update.status).toBe('OPEN')
  })

  it('does NOT reopen a snoozed one', () => {
    // Snoozing is a deliberate "not now". Undoing it on every arrival makes the
    // button useless — which is the whole reason the two states are separate.
    const update = conversationUpdate({ lastMessageAt: noon, status: 'SNOOZED' }, new Date())
    expect(update.status).toBeUndefined()
  })

  it('leaves an open conversation open', () => {
    expect(conversationUpdate({ lastMessageAt: noon, status: 'OPEN' }, new Date()).status).toBeUndefined()
  })
})
