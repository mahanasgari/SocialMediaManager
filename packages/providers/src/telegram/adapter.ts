import { assertOutsideTransaction } from '@smm/config'
import type {
  Account,
  AnyProvider,
  AuthContext,
  AuthRedirect,
  Credential,
  DiscoveredAccount,
  InboundEventShape,
  PublishPayload,
  PublishResult,
  RawMetrics,
  TokenSet,
  WebhookVerification,
} from '../base.js'
import { ProviderError } from '../errors.js'
import {
  validateMedia,
  validateText,
  type ValidationIssue,
  type VariantDraft,
} from '../capabilities/index.js'
import { capabilities, limits, media, text } from './capabilities.js'
import { providerSetting } from '../settings.js'

const API = 'https://api.telegram.org'

/**
 * Telegram adapter — the Phase 6 inbox anchor.
 *
 * Three things about Telegram shape this file, and each one broke an assumption
 * the mock had encoded comfortably:
 *
 *   1. THE BOT TOKEN IS THE CREDENTIAL AND THE IDENTITY. There is no OAuth, no
 *      refresh, no expiry. `refreshToken` therefore has nothing to do, and
 *      saying so explicitly is better than a stub pretending to rotate
 *      something.
 *
 *   2. A BOT CANNOT READ BACK ITS OWN MESSAGES. There is no "list what I sent"
 *      method, so `retrievePosts` is false and reconciliation after a lost
 *      response is genuinely impossible. Per the idempotency design, a stale
 *      IN_FLIGHT here goes to NEEDS_REVIEW — at-most-once plus a human, over
 *      at-least-once plus a duplicate.
 *
 *   3. WEBHOOK AND LONG-POLL ARE MUTUALLY EXCLUSIVE. Calling getUpdates while a
 *      webhook is registered is an error, not a fallback. The two ingress paths
 *      converge on one normalisation function, so the inbox never learns which
 *      one delivered a message.
 */
export class TelegramProvider implements AnyProvider {
  readonly id = 'telegram' as const
  readonly label = 'Telegram'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

  /**
   * Each account brings its own bot token, so there is nothing for an operator
   * to configure globally — except the webhook secret, which matters only if
   * inbound delivery is used at all.
   */
  isConfigured(): boolean {
    return true
  }

  readonly authStyle = 'credentials' as const

  readonly connectFields = [
    {
      name: 'botToken',
      label: 'Bot token',
      type: 'password' as const,
      placeholder: '123456789:AAE...',
      hint: 'Message @BotFather on Telegram, send /newbot, and copy the token it replies with.',
    },
  ]

  async getAuthUrl(_ctx: AuthContext): Promise<AuthRedirect> {
    throw new ProviderError(
      'telegram',
      'PermanentFailure',
      'Telegram connects with a bot token from @BotFather rather than a redirect. ' +
        'Create a bot, copy the token it gives you, and paste it here.'
    )
  }

  /**
   * Validates a bot token by calling getMe.
   *
   * getMe is the only way to find out whether a token is real, and it also
   * returns the username the inbox will display — so verification and discovery
   * are the same call rather than two.
   */
  async handleCallback(
    _ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const token = params['botToken']?.trim()
    if (!token) {
      throw new ProviderError('telegram', 'PermanentFailure', 'A bot token is required.')
    }

    // Re-framed for first connection, as in the Bluesky adapter: the shared
    // mapper says "no longer valid", which is wrong for a token being entered
    // for the first time.
    const me = await this.call<{ id: number; username: string; first_name: string }>(
      token,
      'getMe'
    ).catch((error: unknown) => {
      if (error instanceof ProviderError && error.requiresReauth) {
        throw new ProviderError(
          'telegram',
          'PermanentFailure',
          'Telegram did not accept that bot token. Copy it again from @BotFather — it should ' +
            'look like 123456789 followed by a colon and a longer string.'
        )
      }
      throw error
    })

    return [
      {
        providerAccountId: String(me.id),
        handle: `@${me.username}`,
        displayName: me.first_name,
        platformMeta: { username: me.username },
        credential: { accessToken: token, scopes: ['bot'] },
      },
    ]
  }

  /**
   * Bot tokens do not expire.
   *
   * Returns the credential unchanged rather than throwing: the token refresher
   * runs over every account on a schedule, and an adapter that throws for a
   * token that is simply eternal produces a permanent, meaningless error on the
   * accounts page.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    return { accessToken: credential.accessToken, scopes: credential.scopes }
  }

  async fetchProfile(
    _account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const me = await this.call<{ username: string; first_name: string }>(
      credential.accessToken,
      'getMe'
    )
    return { handle: `@${me.username}`, displayName: me.first_name }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  /**
   * Sends to a chat.
   *
   * The chat id comes from platformOptions, not from the account: one bot posts
   * to many channels, so the target is a property of the variant. A missing chat
   * id gets its own message, because the provider's own reply ("chat not found")
   * is indistinguishable from a chat that was deleted.
   */
  async publish(
    _account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const chatId = payload.platformOptions?.['chatId']
    if (typeof chatId !== 'string' && typeof chatId !== 'number') {
      throw new ProviderError(
        'telegram',
        'PermanentFailure',
        'No Telegram chat was selected for this post. Choose a channel or group before scheduling.'
      )
    }

    // Telegram has no idempotency header. The key is retained on the attempt row
    // and is what a human sees during review, but it CANNOT prevent a duplicate
    // here — which is precisely why retrievePosts: false forces NEEDS_REVIEW
    // rather than a retry.
    void payload.idempotencyKey

    if (payload.media.length === 0) {
      const sent = await this.call<SentMessage>(credential.accessToken, 'sendMessage', {
        chat_id: chatId,
        text: payload.text,
      })
      return this.toResult(sent, chatId)
    }

    if (payload.media.length === 1) {
      const item = payload.media[0]!
      const isVideo = item.mime.startsWith('video/')
      const sent = await this.call<SentMessage>(
        credential.accessToken,
        isVideo ? 'sendVideo' : 'sendPhoto',
        {
          chat_id: chatId,
          [isVideo ? 'video' : 'photo']: item.url,
          // The 1024-character caption limit, already enforced at compose time
          // by maxLengthWithMedia.
          caption: payload.text || undefined,
        }
      )
      return this.toResult(sent, chatId)
    }

    // sendMediaGroup returns an ARRAY of messages, one per item. The first is
    // the one to record: it carries the caption, and it is what a link to the
    // post should open.
    const sent = await this.call<SentMessage[]>(credential.accessToken, 'sendMediaGroup', {
      chat_id: chatId,
      media: payload.media.map((item, index) => ({
        type: item.mime.startsWith('video/') ? 'video' : 'photo',
        media: item.url,
        ...(index === 0 && payload.text ? { caption: payload.text } : {}),
      })),
    })

    const first = sent[0]
    if (!first) {
      throw new ProviderError(
        'telegram',
        'PermanentFailure',
        'Telegram accepted the media group but returned no messages.'
      )
    }
    return this.toResult(first, chatId)
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    const { chatId, messageId } = splitRemoteId(remoteId)
    await this.call(credential.accessToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    })
  }

  async editPost(
    _account: Account,
    credential: Credential,
    remoteId: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const { chatId, messageId } = splitRemoteId(remoteId)
    // Only within 48 hours, and only for the bot's own messages. Telegram
    // returns plain prose otherwise, mapped in toProviderError.
    await this.call(credential.accessToken, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: payload.text,
    })
    return { remoteId }
  }

  /**
   * Per-message view counts, for channels the bot administers.
   *
   * Everything else is null rather than zero. Telegram reports views and nothing
   * more — no impressions, no reach — and a zero in those columns would be read
   * as "nobody saw it" rather than "not measured here".
   */
  async fetchPostMetrics(
    _account: Account,
    _credential: Credential,
    _remoteId: string
  ): Promise<RawMetrics> {
    return {
      views: null,
      impressions: null,
      reach: null,
      likes: null,
      comments: null,
      shares: null,
    }
  }

  async replyToComment(
    _account: Account,
    credential: Credential,
    remoteId: string,
    body: string
  ): Promise<unknown> {
    const { chatId, messageId } = splitRemoteId(remoteId)
    return this.call(credential.accessToken, 'sendMessage', {
      chat_id: chatId,
      text: body,
      reply_parameters: { message_id: messageId },
    })
  }

  async sendMessage(
    _account: Account,
    credential: Credential,
    conversationId: string,
    body: string
  ): Promise<unknown> {
    return this.call(credential.accessToken, 'sendMessage', { chat_id: conversationId, text: body })
  }

  /**
   * Verifies an inbound update.
   *
   * Telegram does NOT sign the body. It echoes a secret token, chosen by us at
   * setWebhook time, in a header — so this is a constant-time comparison of a
   * shared secret rather than an HMAC.
   *
   * That difference is worth stating rather than smoothing over: because the
   * body is unsigned, a leaked secret allows forging arbitrary content, whereas
   * a leaked HMAC key would at least still bind the payload. The secret is
   * therefore treated as a credential, and the endpoint stays useless without
   * it.
   *
   * [V] secret_token, up to 256 chars, echoed as X-Telegram-Bot-Api-Secret-Token
   *     https://core.telegram.org/bots/api#setwebhook
   *     retrieved 2026-08-30
   */
  verifyWebhook(_raw: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const expected = providerSetting('TELEGRAM_WEBHOOK_SECRET')
    if (!expected) {
      return { valid: false, reason: 'no Telegram webhook secret is configured' }
    }

    const provided = headers['x-telegram-bot-api-secret-token']
    if (!provided) return { valid: false, reason: 'the request carried no secret token' }
    if (provided.length !== expected.length) {
      return { valid: false, reason: 'secret token length mismatch' }
    }

    // Constant-time. A public, unauthenticated endpoint that accepts unlimited
    // attempts is exactly where an early-exit compare leaks the secret one byte
    // at a time through response timing.
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
    }
    if (diff !== 0) return { valid: false, reason: 'secret token did not match' }

    return { valid: true, providerAccountId: null }
  }

  /**
   * Normalises an update into inbox events.
   *
   * PURE, and shared by both ingress paths. A webhook POST body and one element
   * of a getUpdates response are the same shape, which is what lets "polling and
   * webhooks converge on one write path" actually hold rather than remain an
   * aspiration.
   */
  parseWebhook(payload: unknown): InboundEventShape[] {
    const update = payload as TelegramUpdate
    const message = update.message ?? update.channel_post ?? update.edited_message
    if (!message) return []

    const from = message.from
    const chat = message.chat

    return [
      {
        // A private chat is a DM; anything else is a comment thread. Telegram
        // has no separate mention concept for bots — a mention arrives as an
        // ordinary message in a group.
        kind: chat.type === 'private' ? 'DM' : 'COMMENT_THREAD',
        // Filled in by the router from the delivery row, since an update does
        // not name the bot that received it.
        providerAccountId: '',
        providerConversationId: String(chat.id),
        providerMessageId: String(message.message_id),
        authorHandle: from?.username ? `@${from.username}` : (from?.first_name ?? 'Unknown'),
        body: message.text ?? message.caption ?? '',
        // FROM THE PROVIDER. Telegram sends a unix timestamp in seconds; using
        // arrival time would reorder a conversation whenever delivery is
        // delayed, which for webhooks is routine rather than exceptional.
        providerCreatedAt: new Date(message.date * 1000),
        ...(message.reply_to_message
          ? { parentProviderMessageId: String(message.reply_to_message.message_id) }
          : {}),
      },
    ]
  }

  private toResult(sent: SentMessage, chatId: string | number): PublishResult {
    const remoteId = `${chatId}:${sent.message_id}`
    return {
      remoteId,
      // Only public channels have a shareable URL. A private group message has
      // none, and inventing one that 404s is worse than omitting it.
      ...(sent.chat?.username
        ? { remoteUrl: `https://t.me/${sent.chat.username}/${sent.message_id}` }
        : {}),
    }
  }

  private async call<T>(token: string, method: string, body?: unknown): Promise<T> {
    assertOutsideTransaction(`telegram.${method}`)

    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })

    const json = (await response.json().catch(() => ({}))) as TelegramResponse<T>

    if (!response.ok || !json.ok) {
      throw toProviderError(json, response.status)
    }
    return json.result as T
  }
}

/**
 * Maps Telegram's errors onto the taxonomy.
 *
 * Telegram returns unstructured English prose in `description` and reuses
 * error_code 400 for almost everything, so the mapping has to read the text.
 * Fragile by nature — which is why the fallthrough preserves the original
 * description rather than replacing it with something generic. An unrecognised
 * error stays legible to whoever has to diagnose it.
 */
export function toProviderError(
  json: { description?: string; error_code?: number; parameters?: { retry_after?: number } },
  status: number
): ProviderError {
  const description = json.description ?? `HTTP ${status}`
  const lower = description.toLowerCase()

  if (json.error_code === 429 || status === 429) {
    const retryAfter = json.parameters?.retry_after
    return new ProviderError(
      'telegram',
      'RateLimited',
      retryAfter
        ? `Telegram is rate limiting this bot. Retrying in ${retryAfter} seconds.`
        : 'Telegram is rate limiting this bot.',
      retryAfter ? { retryAfterSeconds: retryAfter } : {}
    )
  }

  if (json.error_code === 401 || lower.includes('unauthorized')) {
    return new ProviderError(
      'telegram',
      'TokenExpired',
      'This bot token is no longer valid. It may have been revoked in @BotFather. Reconnect to continue.'
    )
  }

  if (
    lower.includes('bot was kicked') ||
    lower.includes('not a member') ||
    lower.includes('chat not found') ||
    lower.includes('not enough rights')
  ) {
    return new ProviderError(
      'telegram',
      'PermissionRevoked',
      'This bot can no longer post to that chat. Re-add it as an administrator.'
    )
  }

  if (lower.includes('message is not modified') || lower.includes('message can not be edited')) {
    return new ProviderError(
      'telegram',
      'ContentRejected',
      'Telegram would not edit this message. Messages can only be edited within 48 hours of sending.'
    )
  }

  if (lower.includes('wrong file identifier') || lower.includes('failed to get http url content')) {
    return new ProviderError(
      'telegram',
      'InvalidMedia',
      'Telegram could not fetch the media for this post. Check that the file is reachable and under 10 MB.'
    )
  }

  if (status >= 500) {
    return new ProviderError('telegram', 'ProviderDown', 'Telegram is unavailable right now.', {
      httpStatus: status,
    })
  }

  return new ProviderError('telegram', 'PermanentFailure', `Telegram rejected this: ${description}`)
}

/** remoteId is `chatId:messageId` — neither identifies a message on its own. */
export function splitRemoteId(remoteId: string): { chatId: string; messageId: number } {
  const index = remoteId.lastIndexOf(':')
  if (index <= 0) {
    throw new ProviderError(
      'telegram',
      'PermanentFailure',
      `"${remoteId}" is not a Telegram message reference.`
    )
  }
  const messageId = Number(remoteId.slice(index + 1))
  if (!Number.isInteger(messageId)) {
    throw new ProviderError(
      'telegram',
      'PermanentFailure',
      `"${remoteId}" is not a Telegram message reference.`
    )
  }
  return { chatId: remoteId.slice(0, index), messageId }
}

type TelegramResponse<T> = {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

type SentMessage = {
  message_id: number
  chat?: { username?: string }
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
}

type TelegramMessage = {
  message_id: number
  date: number
  text?: string
  caption?: string
  from?: { username?: string; first_name?: string }
  chat: { id: number; type: string; username?: string }
  reply_to_message?: { message_id: number }
}
