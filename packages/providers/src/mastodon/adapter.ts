import { assertOutsideTransaction } from '@smm/config'
import type {
  Account,
  AnyProvider,
  AuthContext,
  AuthRedirect,
  Credential,
  DiscoveredAccount,
  PublishPayload,
  PublishResult,
  RawMetrics,
  RemotePost,
  TokenSet,
} from '../base.js'
import { ProviderError } from '../errors.js'
import {
  validateMedia,
  validateText,
  type ValidationIssue,
  type VariantDraft,
} from '../capabilities/index.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Mastodon adapter — the Phase 4 publishing anchor.
 *
 * Four things here that no mock would have taught us:
 *
 *   1. THE APP IS REGISTERED PER INSTANCE. There is no global client id.
 *      Connecting to a new instance means POSTing to /api/v1/apps on that
 *      instance first, which is why AuthContext carries instanceUrl and why
 *      `isConfigured()` can return true with no operator credentials at all.
 *
 *   2. MEDIA UPLOAD RETURNS BEFORE PROCESSING FINISHES. v2/media answers 202
 *      with a null `url` while the server transcodes. Attaching that id to a
 *      status immediately fails, so the upload path polls until the attachment
 *      is ready. This is the single most important thing the anchor exposed.
 *
 *   3. IDEMPOTENCY IS NATIVE. The Idempotency-Key header genuinely suppresses
 *      duplicates, which makes Mastodon the one connector so far where
 *      exactly-once is the provider's guarantee rather than our reconstruction.
 *
 *   4. THE CHARACTER LIMIT IS PER INSTANCE. 500 is a default, not a rule, and
 *      the real value is read at connect time and stored on the account.
 */
export class MastodonProvider implements AnyProvider {
  readonly id = 'mastodon' as const
  readonly label = 'Mastodon'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

  /**
   * Needs no operator credentials.
   *
   * The app is registered against whichever instance the user names, at the
   * moment they connect. There is nothing for an administrator to put in an env
   * file, which is what makes this connector usable on a fresh self-hosted
   * install.
   */
  isConfigured(): boolean {
    return true
  }

  /**
   * OAuth, but not until someone names an instance.
   *
   * There is no global Mastodon — the authorize URL lives on a specific server,
   * and the app has to be registered there first. So this is a redirect flow
   * that nonetheless cannot begin without a field, which is why connectFields
   * is not exclusive to credential-based providers.
   */
  readonly authStyle = 'oauth' as const

  readonly connectFields = [
    {
      name: 'instanceUrl',
      label: 'Instance',
      type: 'text' as const,
      placeholder: 'mastodon.social',
      hint: 'The server your account is on — the part after the second @ in your handle.',
    },
  ]

  /**
   * Registers an app on the instance, then returns its authorize URL.
   *
   * The client secret comes back from THIS call and is needed again at token
   * exchange, so it rides along in the returned state. It never reaches the
   * browser as a separate value — the caller stores it with the pending
   * connection.
   */
  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const instance = normaliseInstance(ctx.instanceUrl)

    const app = await this.call<{ client_id: string; client_secret: string }>(
      instance,
      '/api/v1/apps',
      {
        method: 'POST',
        body: {
          client_name: 'Social Media Manager',
          redirect_uris: ctx.redirectUri,
          scopes: SCOPES,
          website: ctx.redirectUri.replace(/\/api\/.*$/, ''),
        },
      }
    )

    const url = new URL('/oauth/authorize', instance)
    url.searchParams.set('client_id', app.client_id)
    url.searchParams.set('redirect_uri', ctx.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES)
    // The instance and the app credentials must survive the round trip, since
    // the token exchange happens against the same instance with the same app.
    url.searchParams.set(
      'state',
      encodeState({ state: ctx.state, instance, clientId: app.client_id, clientSecret: app.client_secret })
    )

    return { url: url.toString(), state: ctx.state }
  }

  async handleCallback(
    ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const code = params['code']
    if (!code) {
      throw new ProviderError(
        'mastodon',
        'PermanentFailure',
        params['error_description'] ?? params['error'] ?? 'Mastodon did not return an authorization code.'
      )
    }

    const carried = decodeState(params['state'] ?? '')
    const instance = normaliseInstance(carried?.instance ?? ctx.instanceUrl)
    if (!carried) {
      throw new ProviderError(
        'mastodon',
        'PermanentFailure',
        'The connection link was incomplete. Start connecting again from the accounts page.'
      )
    }

    const token = await this.call<{ access_token: string; scope?: string }>(
      instance,
      '/oauth/token',
      {
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          client_id: carried.clientId,
          client_secret: carried.clientSecret,
          redirect_uri: ctx.redirectUri,
          code,
          scope: SCOPES,
        },
      }
    )

    const account = await this.call<MastodonAccount>(
      instance,
      '/api/v1/accounts/verify_credentials',
      { method: 'GET', token: token.access_token }
    )

    // The instance's REAL character limit, not the 500 default. Instances
    // routinely raise it, and a composer that enforces 500 against an instance
    // allowing 5000 is wrong in the direction users notice most.
    const config = await this.call<InstanceConfig>(instance, '/api/v2/instance', { method: 'GET' })
      .catch(() => null)

    const maxChars = config?.configuration?.statuses?.max_characters ?? null
    const maxAttachments = config?.configuration?.statuses?.max_media_attachments ?? null

    return [
      {
        // The instance is part of the identity: @alice@one.social and
        // @alice@two.social are different accounts, and a providerAccountId of
        // just the numeric id would collide across instances.
        providerAccountId: `${instance}#${account.id}`,
        handle: `@${account.username}@${hostOf(instance)}`,
        displayName: account.display_name || account.username,
        ...(account.avatar ? { avatarUrl: account.avatar } : {}),
        platformMeta: {
          instance,
          accountId: account.id,
          clientId: carried.clientId,
          clientSecret: carried.clientSecret,
          ...(maxChars !== null ? { maxCharacters: maxChars } : {}),
          ...(maxAttachments !== null ? { maxAttachments } : {}),
        },
        credential: {
          accessToken: token.access_token,
          // Mastodon tokens do not expire and there is no refresh token. Saying
          // so here rather than storing an empty refresh token that a refresher
          // would later try to use.
          scopes: (token.scope ?? SCOPES).split(' '),
        },
      },
    ]
  }

  /**
   * Mastodon access tokens do not expire.
   *
   * Returned unchanged rather than throwing: the refresher sweeps every account
   * on a schedule, and an adapter that throws for a token that is simply eternal
   * produces a permanent, meaningless error on the accounts page.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    return { accessToken: credential.accessToken, scopes: credential.scopes }
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const instance = instanceOf(account)
    const me = await this.call<MastodonAccount>(
      instance,
      '/api/v1/accounts/verify_credentials',
      { method: 'GET', token: credential.accessToken }
    )
    return {
      handle: `@${me.username}@${hostOf(instance)}`,
      displayName: me.display_name || me.username,
    }
  }

  /**
   * Validates against THIS account's instance limit where we know it.
   *
   * `validate` is pure and takes only the draft, so the instance limit cannot
   * reach it — the profile is per provider, not per account. `validateFor` is
   * the account-aware variant the composer uses when it has one.
   */
  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  /** Account-aware validation, using the instance limit discovered at connect. */
  validateFor(draft: VariantDraft, account: Account): ValidationIssue[] {
    const profile = this.text[draft.surface]
    const max = Number((account.platformMeta as { maxCharacters?: number })?.maxCharacters)

    if (!profile || !Number.isFinite(max)) return this.validate(draft)

    return [
      ...validateText(draft, { ...profile, maxLength: max }, `${this.label} (${hostOf(instanceOf(account))})`),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const instance = instanceOf(account)

    const mediaIds: string[] = []
    for (const item of payload.media) {
      mediaIds.push(await this.uploadMedia(instance, credential.accessToken, item))
    }

    const options = payload.platformOptions ?? {}

    const status = await this.call<MastodonStatus>(instance, '/api/v1/statuses', {
      method: 'POST',
      token: credential.accessToken,
      // NATIVE IDEMPOTENCY. Mastodon genuinely suppresses a duplicate for the
      // same key, which makes this the one connector where exactly-once is the
      // provider's guarantee rather than our reconstruction from a fingerprint.
      idempotencyKey: payload.idempotencyKey,
      body: {
        status: payload.text,
        ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
        visibility: visibilityOf(options['visibility']),
        ...(typeof options['spoilerText'] === 'string' && options['spoilerText']
          ? { spoiler_text: options['spoilerText'] }
          : {}),
        ...(options['sensitive'] === true ? { sensitive: true } : {}),
        ...(typeof options['inReplyToId'] === 'string'
          ? { in_reply_to_id: options['inReplyToId'] }
          : {}),
        ...(typeof options['language'] === 'string' ? { language: options['language'] } : {}),
      },
    })

    return { remoteId: status.id, ...(status.url ? { remoteUrl: status.url } : {}) }
  }

  /**
   * Uploads one attachment and WAITS for the instance to finish processing it.
   *
   * v2/media answers 202 with a null `url` while the server transcodes, and
   * attaching that id to a status immediately fails. The mock returned a ready
   * id synchronously, so this whole branch existed only once a real instance
   * was involved — it is the single most valuable thing this anchor exposed.
   */
  private async uploadMedia(
    instance: string,
    token: string,
    item: { url: string; mime: string; altText?: string }
  ): Promise<string> {
    assertOutsideTransaction('mastodon.uploadMedia')

    const source = await fetch(item.url, { signal: AbortSignal.timeout(60_000) })
    if (!source.ok) {
      throw new ProviderError(
        'mastodon',
        'InvalidMedia',
        `The media for this post could not be read (${source.status}).`
      )
    }

    const form = new FormData()
    form.append('file', new Blob([await source.arrayBuffer()], { type: item.mime }), 'upload')
    if (item.altText) form.append('description', item.altText)

    const response = await fetch(new URL('/api/v2/media', instance), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })

    const attachment = (await response.json().catch(() => ({}))) as { id?: string; url?: string | null }
    if (!response.ok || !attachment.id) {
      throw toProviderError(response.status, attachment, 'uploading media')
    }

    // 200 means processing is already done. 202 means it is not.
    if (response.status === 200 && attachment.url) return attachment.id

    return this.awaitProcessing(instance, token, attachment.id)
  }

  /**
   * Polls until the attachment is ready.
   *
   * Bounded rather than open-ended: a video that never finishes must fail with a
   * usable message, not hold a publish job forever. GET v1/media/:id answers 206
   * while still processing and 200 once done.
   */
  private async awaitProcessing(instance: string, token: string, id: string): Promise<string> {
    const deadline = Date.now() + 120_000

    while (Date.now() < deadline) {
      await sleep(2000)

      const response = await fetch(new URL(`/api/v1/media/${id}`, instance), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      })

      if (response.status === 200) return id
      if (response.status === 206) continue

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      throw toProviderError(response.status, body, 'waiting for media to process')
    }

    throw new ProviderError(
      'mastodon',
      'InvalidMedia',
      'The instance did not finish processing this media within two minutes. ' +
        'Large videos sometimes exceed what a small instance can transcode — try a shorter clip.'
    )
  }

  /**
   * Recent statuses, for reconciliation after a lost response.
   *
   * The reason Mastodon anchors the idempotency design: this is a REAL read-back
   * path, so a stale IN_FLIGHT can be resolved by looking rather than by
   * guessing or by asking a human.
   */
  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const instance = instanceOf(account)
    const accountId = (account.platformMeta as { accountId?: string })?.accountId

    const statuses = await this.call<MastodonStatus[]>(
      instance,
      `/api/v1/accounts/${accountId}/statuses?limit=40&exclude_replies=false`,
      { method: 'GET', token: credential.accessToken }
    )

    return statuses
      .filter((s) => new Date(s.created_at) >= since)
      .map((s) => ({
        remoteId: s.id,
        createdAt: new Date(s.created_at),
        // Statuses come back as HTML. Stripped to plain text because the
        // fingerprint compares against what we SENT, which was never markup.
        text: stripHtml(s.content),
        mediaCount: s.media_attachments?.length ?? 0,
      }))
  }

  async deletePost(account: Account, credential: Credential, remoteId: string): Promise<void> {
    await this.call(instanceOf(account), `/api/v1/statuses/${remoteId}`, {
      method: 'DELETE',
      token: credential.accessToken,
    })
  }

  async editPost(
    account: Account,
    credential: Credential,
    remoteId: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const status = await this.call<MastodonStatus>(
      instanceOf(account),
      `/api/v1/statuses/${remoteId}`,
      { method: 'PUT', token: credential.accessToken, body: { status: payload.text } }
    )
    return { remoteId: status.id, ...(status.url ? { remoteUrl: status.url } : {}) }
  }

  async revokeToken(credential: Credential): Promise<void> {
    void credential
    // Revocation needs the app's client id and secret, which live on the
    // account's platformMeta rather than on the credential. Rather than pretend
    // otherwise, this is a no-op and the token is destroyed locally — which is
    // what actually protects the user, since a token we no longer hold cannot
    // be used by us.
  }

  async fetchComments(
    account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<unknown[]> {
    const context = await this.call<{ descendants: MastodonStatus[] }>(
      instanceOf(account),
      `/api/v1/statuses/${remoteId}/context`,
      { method: 'GET', token: credential.accessToken }
    )
    return context.descendants ?? []
  }

  async replyToComment(
    account: Account,
    credential: Credential,
    remoteId: string,
    body: string
  ): Promise<unknown> {
    return this.call<MastodonStatus>(instanceOf(account), '/api/v1/statuses', {
      method: 'POST',
      token: credential.accessToken,
      body: { status: body, in_reply_to_id: remoteId },
    })
  }

  /**
   * Engagement counts from the status itself.
   *
   * Impressions and reach are NULL, not zero. Mastodon has no insights API and
   * reporting an unmeasured metric as zero would be a lie about a number nobody
   * counted — the UI must render those as "—".
   */
  async fetchPostMetrics(
    account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const status = await this.call<MastodonStatus>(
      instanceOf(account),
      `/api/v1/statuses/${remoteId}`,
      { method: 'GET', token: credential.accessToken }
    )

    return {
      likes: status.favourites_count ?? null,
      shares: status.reblogs_count ?? null,
      comments: status.replies_count ?? null,
      impressions: null,
      reach: null,
      clicks: null,
      saves: null,
    }
  }

  private async call<T>(
    instance: string,
    path: string,
    options: {
      method: string
      token?: string
      body?: unknown
      idempotencyKey?: string
    }
  ): Promise<T> {
    assertOutsideTransaction(`mastodon ${options.method} ${path}`)

    const response = await fetch(new URL(path, instance), {
      method: options.method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (!response.ok) {
      throw toProviderError(response.status, json, `${options.method} ${path}`, response.headers)
    }
    return json as T
  }
}

const SCOPES = 'read write follow'

/**
 * Maps Mastodon's errors onto the taxonomy.
 *
 * Mastodon returns `{ error, error_description }` with reasonably consistent
 * status codes, so this mapping leans on the status first and the text only
 * where the status is ambiguous. The original description is preserved in the
 * fallthrough, because an unrecognised error still has to be diagnosable.
 */
export function toProviderError(
  status: number,
  body: Record<string, unknown>,
  context: string,
  headers?: Headers
): ProviderError {
  const detail =
    (typeof body['error_description'] === 'string' && body['error_description']) ||
    (typeof body['error'] === 'string' && body['error']) ||
    `HTTP ${status}`

  if (status === 429) {
    const reset = headers?.get('x-ratelimit-reset')
    const seconds = reset ? Math.max(1, Math.ceil((Date.parse(reset) - Date.now()) / 1000)) : undefined
    return new ProviderError(
      'mastodon',
      'RateLimited',
      seconds
        ? `This instance is rate limiting the account. Retrying in ${seconds} seconds.`
        : 'This instance is rate limiting the account.',
      { httpStatus: status, ...(seconds ? { retryAfterSeconds: seconds } : {}) }
    )
  }

  if (status === 401) {
    return new ProviderError(
      'mastodon',
      'TokenExpired',
      'This Mastodon account is no longer authorised. It may have been revoked in the ' +
        'instance settings. Reconnect to continue.',
      { httpStatus: status }
    )
  }

  if (status === 403) {
    return new ProviderError(
      'mastodon',
      'PermissionRevoked',
      `This account does not have permission to do that on its instance (${detail}).`,
      { httpStatus: status }
    )
  }

  if (status === 422) {
    return new ProviderError(
      'mastodon',
      'ContentRejected',
      `The instance rejected this post: ${detail}`,
      { httpStatus: status }
    )
  }

  if (status === 413) {
    return new ProviderError(
      'mastodon',
      'InvalidMedia',
      'That file is larger than this instance accepts. Instance limits vary, and many are ' +
        'well below the defaults.',
      { httpStatus: status }
    )
  }

  if (status >= 500 || status === 0) {
    return new ProviderError(
      'mastodon',
      'ProviderDown',
      'The instance is not responding right now.',
      { httpStatus: status }
    )
  }

  return new ProviderError('mastodon', 'PermanentFailure', `Mastodon refused ${context}: ${detail}`, {
    httpStatus: status,
  })
}

/** Accepts `example.social`, `https://example.social`, or a trailing slash. */
export function normaliseInstance(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) {
    throw new ProviderError(
      'mastodon',
      'PermanentFailure',
      'A Mastodon instance address is required, for example mastodon.social.'
    )
  }

  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ProviderError('mastodon', 'PermanentFailure', `"${raw}" is not a valid instance address.`)
  }

  // Forced to https. An instance reached over plain http would carry the access
  // token in clear text, and there is no version of that worth supporting.
  if (url.protocol !== 'https:') {
    throw new ProviderError(
      'mastodon',
      'PermanentFailure',
      'Mastodon instances must be reachable over https.'
    )
  }

  return `https://${url.host}`
}

export function hostOf(instance: string): string {
  try {
    return new URL(instance).host
  } catch {
    return instance
  }
}

function instanceOf(account: Account): string {
  const instance = (account.platformMeta as { instance?: string })?.instance
  if (!instance) {
    throw new ProviderError(
      'mastodon',
      'PermanentFailure',
      'This account is missing its instance address. Reconnect it to repair the connection.'
    )
  }
  return instance
}

/** Only the four Mastodon accepts; anything else would be a 422 at publish. */
export function visibilityOf(value: unknown): 'public' | 'unlisted' | 'private' | 'direct' {
  return value === 'unlisted' || value === 'private' || value === 'direct' ? value : 'public'
}

/**
 * Statuses come back as HTML; the fingerprint compares against what we SENT,
 * which was plain text. Deliberately minimal — this feeds similarity matching,
 * not display, so it needs to be stable rather than perfect.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function encodeState(payload: {
  state: string
  instance: string
  clientId: string
  clientSecret: string
}): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeState(raw: string): {
  state: string
  instance: string
  clientId: string
  clientSecret: string
} | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      typeof parsed['instance'] === 'string' &&
      typeof parsed['clientId'] === 'string' &&
      typeof parsed['clientSecret'] === 'string' &&
      typeof parsed['state'] === 'string'
    ) {
      return parsed as { state: string; instance: string; clientId: string; clientSecret: string }
    }
    return null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type MastodonAccount = {
  id: string
  username: string
  display_name: string
  avatar?: string
}

type MastodonStatus = {
  id: string
  url?: string | null
  content: string
  created_at: string
  favourites_count?: number
  reblogs_count?: number
  replies_count?: number
  media_attachments?: unknown[]
}

type InstanceConfig = {
  configuration?: {
    statuses?: {
      max_characters?: number
      max_media_attachments?: number
    }
  }
}
