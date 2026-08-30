import { afterEach, describe, expect, it } from 'vitest'
import { TelegramProvider, splitRemoteId, toProviderError } from './adapter.js'
import { capabilities, text } from './capabilities.js'
import { validateText } from '../capabilities/index.js'

const telegram = new TelegramProvider()

afterEach(() => {
  delete process.env['TELEGRAM_WEBHOOK_SECRET']
})

describe('remote id', () => {
  // A Telegram message is identified by (chat, message) — the message_id alone
  // is not unique across chats, so storing only it would make deletion and
  // editing target the wrong message.
  it('splits a chat and message pair', () => {
    expect(splitRemoteId('-1001234567890:42')).toEqual({
      chatId: '-1001234567890',
      messageId: 42,
    })
  })

  it('handles an @username chat, which contains no colon', () => {
    expect(splitRemoteId('@mychannel:7')).toEqual({ chatId: '@mychannel', messageId: 7 })
  })

  it('splits on the LAST colon, so a chat containing one still works', () => {
    expect(splitRemoteId('a:b:9')).toEqual({ chatId: 'a:b', messageId: 9 })
  })

  it('refuses a reference with no message id rather than producing NaN', () => {
    expect(() => splitRemoteId('12345')).toThrow(/not a Telegram message reference/)
    expect(() => splitRemoteId('chat:notanumber')).toThrow(/not a Telegram message reference/)
  })
})

describe('webhook verification', () => {
  const raw = Buffer.from('{"update_id":1}', 'utf8')

  it('REFUSES when no secret is configured', () => {
    const result = telegram.verifyWebhook(raw, {})
    expect(result.valid).toBe(false)
  })

  it('accepts the matching secret token', () => {
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'a-long-random-secret-value'
    const result = telegram.verifyWebhook(raw, {
      'x-telegram-bot-api-secret-token': 'a-long-random-secret-value',
    })
    expect(result.valid).toBe(true)
  })

  it('rejects a wrong secret of the same length', () => {
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'a-long-random-secret-value'
    const result = telegram.verifyWebhook(raw, {
      'x-telegram-bot-api-secret-token': 'a-long-random-secret-VALUE',
    })
    expect(result.valid).toBe(false)
  })

  it('rejects a missing header', () => {
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'a-long-random-secret-value'
    expect(telegram.verifyWebhook(raw, {}).valid).toBe(false)
  })

  it('rejects a prefix of the correct secret', () => {
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'a-long-random-secret-value'
    expect(
      telegram.verifyWebhook(raw, { 'x-telegram-bot-api-secret-token': 'a-long' }).valid
    ).toBe(false)
  })
})

describe('parseWebhook', () => {
  const base = {
    update_id: 900,
    message: {
      message_id: 55,
      // 2026-08-30T12:00:00Z
      date: 1788091200,
      text: 'when is the next drop?',
      from: { username: 'ada', first_name: 'Ada' },
      chat: { id: 4242, type: 'private' },
    },
  }

  it('classifies a private chat as a DM', () => {
    const [event] = telegram.parseWebhook(base)
    expect(event?.kind).toBe('DM')
    expect(event?.providerConversationId).toBe('4242')
    expect(event?.providerMessageId).toBe('55')
    expect(event?.authorHandle).toBe('@ada')
    expect(event?.body).toBe('when is the next drop?')
  })

  it('classifies a group chat as a comment thread', () => {
    const [event] = telegram.parseWebhook({
      ...base,
      message: { ...base.message, chat: { id: -100, type: 'supergroup' } },
    })
    expect(event?.kind).toBe('COMMENT_THREAD')
  })

  it('uses the PROVIDER timestamp, not arrival time', () => {
    // Webhooks arrive out of order routinely. Ordering on arrival reshuffles a
    // conversation whenever delivery is delayed.
    const [event] = telegram.parseWebhook(base)
    expect(event?.providerCreatedAt.toISOString()).toBe('2026-08-30T12:00:00.000Z')
  })

  it('falls back to a first name when there is no username', () => {
    const [event] = telegram.parseWebhook({
      ...base,
      message: { ...base.message, from: { first_name: 'Grace' } },
    })
    expect(event?.authorHandle).toBe('Grace')
  })

  it('carries the parent id for a reply, so threading survives', () => {
    const [event] = telegram.parseWebhook({
      ...base,
      message: { ...base.message, reply_to_message: { message_id: 11 } },
    })
    expect(event?.parentProviderMessageId).toBe('11')
  })

  it('reads a caption when a media message has no text', () => {
    const [event] = telegram.parseWebhook({
      ...base,
      message: { ...base.message, text: undefined, caption: 'look at this' },
    })
    expect(event?.body).toBe('look at this')
  })

  it('handles a channel post, which arrives under a different key entirely', () => {
    const [event] = telegram.parseWebhook({
      update_id: 901,
      channel_post: { ...base.message, chat: { id: -900, type: 'channel' } },
    })
    expect(event?.kind).toBe('COMMENT_THREAD')
    expect(event?.providerConversationId).toBe('-900')
  })

  it('returns nothing for an update carrying no message', () => {
    // Telegram sends update types we do not handle — poll answers, chat member
    // changes. Producing zero events is correct; throwing would fail a delivery
    // that was simply not for us.
    expect(telegram.parseWebhook({ update_id: 902 })).toEqual([])
    expect(telegram.parseWebhook({ update_id: 903, poll: { id: 'x' } })).toEqual([])
  })
})

describe('error mapping', () => {
  it('maps a 429 with retry_after, and does not call it a failure', () => {
    const error = toProviderError(
      { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } },
      429
    )
    expect(error.code).toBe('RateLimited')
    expect(error.options.retryAfterSeconds).toBe(30)
    expect(error.retryable).toBe(true)
  })

  it('maps a revoked token to TokenExpired with a recovery instruction', () => {
    const error = toProviderError({ error_code: 401, description: 'Unauthorized' }, 401)
    expect(error.code).toBe('TokenExpired')
    expect(error.message).toMatch(/BotFather/)
  })

  it('maps being removed from a chat to PermissionRevoked', () => {
    expect(toProviderError({ description: 'Forbidden: bot was kicked from the group chat' }, 403).code).toBe(
      'PermissionRevoked'
    )
    expect(toProviderError({ description: 'Bad Request: chat not found' }, 400).code).toBe(
      'PermissionRevoked'
    )
  })

  it('explains the 48-hour edit window rather than repeating the raw error', () => {
    const error = toProviderError({ description: 'Bad Request: message is not modified' }, 400)
    expect(error.code).toBe('ContentRejected')
    expect(error.message).toMatch(/48 hours/)
  })

  it('maps an unreachable media URL to InvalidMedia', () => {
    expect(
      toProviderError({ description: 'Bad Request: failed to get HTTP URL content' }, 400).code
    ).toBe('InvalidMedia')
  })

  it('treats a 5xx as retryable rather than permanent', () => {
    const error = toProviderError({ description: 'Bad Gateway' }, 502)
    expect(error.code).toBe('ProviderDown')
    expect(error.retryable).toBe(true)
  })

  it('PRESERVES an unrecognised description instead of replacing it', () => {
    // The mapping reads English prose and is fragile by nature. An unrecognised
    // error must stay legible to whoever has to diagnose it, so the fallthrough
    // keeps the original text.
    const error = toProviderError({ description: 'Bad Request: PEER_ID_INVALID' }, 400)
    expect(error.code).toBe('PermanentFailure')
    expect(error.message).toContain('PEER_ID_INVALID')
  })
})

describe('caption limit', () => {
  const profile = text.feed!

  it('allows a long message with no media', () => {
    const issues = validateText(
      { text: 'x'.repeat(2000), media: [], surface: 'feed' },
      profile,
      'Telegram'
    )
    expect(issues).toEqual([])
  })

  it('rejects the SAME text once media is attached', () => {
    // 4096 for a message, 1024 for a caption. A composer showing 4096 and then
    // failing at publish time has told the writer a comfortable lie — and they
    // find out after the draft is written.
    const issues = validateText(
      {
        text: 'x'.repeat(2000),
        media: [{ mime: 'image/jpeg', bytes: 1000 }],
        surface: 'feed',
      },
      profile,
      'Telegram'
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('text_too_long')
  })

  it('says WHICH limit applies, so the number does not look wrong', () => {
    const [issue] = validateText(
      { text: 'x'.repeat(1100), media: [{ mime: 'image/jpeg', bytes: 10 }], surface: 'feed' },
      profile,
      'Telegram'
    )
    expect(issue?.message).toMatch(/with media/)
    expect(issue?.message).toContain('1024')
    expect(issue?.message).toContain('4096')
  })
})

describe('capability honesty', () => {
  it('does not claim to read back its own posts', () => {
    // A bot has no "list what I sent" method, so reconciliation after a lost
    // response is impossible and a stale IN_FLIGHT must go to NEEDS_REVIEW.
    expect(capabilities.retrievePosts).toBe(false)
  })

  it('claims replies but NOT comment retrieval', () => {
    // The concept exists; retrieval does not. Comments arrive as updates in the
    // linked discussion group or they are not observed at all.
    expect(capabilities.comments).toBe(false)
    expect(capabilities.replies).toBe(true)
  })

  it('reports no metric as zero', async () => {
    const metrics = await telegram.fetchPostMetrics(
      {} as never,
      {} as never,
      'chat:1'
    )
    // Null, not 0. Telegram reports views and nothing else; a zero in the
    // impressions column reads as "nobody saw it" rather than "not measured".
    expect(metrics['impressions']).toBeNull()
    expect(metrics['reach']).toBeNull()
  })
})
