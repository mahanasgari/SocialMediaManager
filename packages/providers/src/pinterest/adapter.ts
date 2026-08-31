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

const API = 'https://api.pinterest.com/v5'

/**
 * Pinterest.
 *
 * Implemented, with one caveat that is Pinterest's rule rather than a gap in
 * this code, and which is therefore SURFACED rather than hidden:
 *
 *   AN APP ON TRIAL ACCESS CREATES SANDBOX PINS. They are visible only to
 *   their creator. The API returns success, a pin id comes back, and nothing
 *   anywhere reports a problem — the pin simply does not exist for anyone else.
 *   That is the worst failure mode in this whole system: a publish that is
 *   indistinguishable from a real one and reaches nobody. The connector
 *   therefore carries a `notice` shown wherever it can be connected, because
 *   there is no runtime signal we could check instead.
 *
 * [V] Access tiers and the sandbox behaviour —
 * https://developers.pinterest.com/docs/getting-started/access/, retrieved
 * 2026-08-29.
 * [V] Pin creation, retrieved 2026-08-31 —
 * https://developers.pinterest.com/docs/api/v5/pins-create/
 * [V] OAuth token endpoint, retrieved 2026-08-31 —
 * https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
 *
 * The other thing this API forces is that A PIN NEEDS A BOARD. There is no
 * default and no "post to my profile" — every pin belongs somewhere. Boards are
 * read at connect time and one is remembered as the default; a variant can name
 * a different one through platformOptions.
 */
export class PinterestProvider implements AnyProvider {
  readonly id = 'pinterest' as const
  readonly label = 'Pinterest'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  /**
   * Shown wherever this provider can be connected.
   *
   * Not a `blockedReason` — the connector works. It is the thing an operator
   * must know BEFORE they schedule a week of content into a sandbox.
   */
  readonly notice =
    'If your Pinterest app is still on Trial access, pins created through the API are ' +
    'sandbox pins: they are visible only to you, and nothing in the response says so. ' +
    'Apply for Standard access before scheduling anything you expect people to see.'

  private static readonly SCOPES = [
    'boards:read',
    'pins:read',
    'pins:write',
    'user_accounts:read',
  ] as const

  isConfigured(): boolean {
    return this.app() !== null
  }

  private app(): { id: string; secret: string } | null {
    const id = process.env['PINTEREST_APP_ID']
    const secret = process.env['PINTEREST_APP_SECRET']
    if (!id || !secret) return null
    return { id, secret }
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = this.app()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Set PINTEREST_APP_ID and PINTEREST_APP_SECRET to connect Pinterest.'
      )
    }

    const url = new URL('https://www.pinterest.com/oauth/')
    url.searchParams.set('client_id', app.id)
    url.searchParams.set('redirect_uri', ctx.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', PinterestProvider.SCOPES.join(','))
    url.searchParams.set('state', ctx.state)

    return { url: url.toString(), state: ctx.state }
  }

  async handleCallback(
    ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const code = params['code']
    if (!code) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        params['error_description'] ?? 'Pinterest did not return an authorization code.'
      )
    }

    const token = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
    })

    const [profile, boards] = await Promise.all([
      this.call<{ username: string; account_type?: string }>('/user_account', token.accessToken),
      this.call<{ items?: Array<{ id: string; name: string }> }>(
        '/boards?page_size=100',
        token.accessToken
      ),
    ])

    const available = boards.items ?? []
    if (available.length === 0) {
      // Refused at connect rather than at publish. A Pinterest account with no
      // board cannot receive a pin, and finding that out when a scheduled post
      // fails is finding out too late.
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'This Pinterest account has no boards. Create one, then connect again.'
      )
    }

    return [
      {
        providerAccountId: profile.username,
        handle: `@${profile.username}`,
        displayName: profile.username,
        credential: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scopes: [...PinterestProvider.SCOPES],
        },
        platformMeta: {
          boards: available.map((b) => ({ id: b.id, name: b.name })),
          // The first board is remembered so a pin can be published without
          // the composer having a board picker yet. It is stored, not
          // hard-coded, so choosing another one later changes data rather than
          // code.
          defaultBoardId: available[0]!.id,
          accountType: profile.account_type ?? null,
        },
      },
    ]
  }

  /**
   * Pinterest tokens expire in 30 days and refresh indefinitely.
   *
   * Unlike the Meta connectors there IS a refresh path here, and using it
   * matters: an account left unrefreshed for a month stops publishing, and the
   * first sign is a failed scheduled post.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    if (!credential.refreshToken) {
      throw new ProviderError(
        this.id,
        'TokenExpired',
        'No refresh token is stored for this account. Reconnect it.'
      )
    }

    const token = await this.token({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    })

    return {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    }
  }

  async fetchProfile(
    _account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const profile = await this.call<{ username: string }>('/user_account', credential.accessToken)
    return { handle: `@${profile.username}`, displayName: profile.username }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    const issues = [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]

    // A pin IS an image. There is no text-only pin, and saying so in the
    // composer is cheaper than a failed publish.
    if (draft.media.length === 0) {
      issues.push({
        severity: 'error',
        code: 'media_required',
        message: 'A Pin must have an image.',
      })
    }

    return issues
  }

  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const asset = payload.media[0]
    if (!asset) {
      throw new ProviderError(this.id, 'ContentRejected', 'A Pin must have an image.')
    }

    const meta = account.platformMeta as { defaultBoardId?: string } | undefined
    const boardId =
      (payload.platformOptions?.['boardId'] as string | undefined) ?? meta?.defaultBoardId

    if (!boardId) {
      throw new ProviderError(
        this.id,
        'ContentRejected',
        'No Pinterest board was chosen and this account has no default. Reconnect it.'
      )
    }

    const pin = await this.call<{ id: string }>('/pins', credential.accessToken, {
      method: 'POST',
      body: {
        board_id: boardId,
        // Pinterest shows the title above the description, and a pin with no
        // title renders as a bare image. The first line is used when the author
        // supplied no explicit title, which is what people write anyway.
        title: payload.title ?? firstLine(payload.text),
        description: payload.text,
        media_source: { source_type: 'image_url', url: asset.url },
        ...(asset.altText ? { alt_text: asset.altText } : {}),
        ...(payload.platformOptions?.['link']
          ? { link: String(payload.platformOptions['link']) }
          : {}),
      },
    })

    return {
      remoteId: pin.id,
      remoteUrl: `https://www.pinterest.com/pin/${pin.id}/`,
      providerRequestId: pin.id,
    }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    await this.call(`/pins/${remoteId}`, credential.accessToken, { method: 'DELETE' })
  }

  async retrievePosts(
    _account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const body = await this.call<{
      items?: Array<{ id: string; created_at: string; description?: string; title?: string }>
    }>('/pins?page_size=50', credential.accessToken)

    const cutoff = since.getTime() - 60_000
    return (body.items ?? [])
      .map((pin) => ({
        remoteId: pin.id,
        createdAt: new Date(pin.created_at),
        text: pin.description ?? pin.title ?? '',
        mediaCount: 1,
      }))
      .filter((pin) => pin.createdAt.getTime() >= cutoff)
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const body = await this.call<{
      all?: { daily?: Array<Record<string, number>>; lifetime_metrics?: Record<string, number> }
    }>(
      `/pins/${remoteId}/analytics?metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE` +
        `&start_date=${isoDate(daysAgo(30))}&end_date=${isoDate(new Date())}`,
      credential.accessToken
    )

    const lifetime = body.all?.lifetime_metrics ?? {}
    return {
      impressions: numeric(lifetime['IMPRESSION']),
      clicks: numeric(lifetime['PIN_CLICK']),
      // An outbound click is a visit to the linked site — the metric Pinterest
      // users actually care about, and one no other network in this system has.
      outboundClicks: numeric(lifetime['OUTBOUND_CLICK']),
      saves: numeric(lifetime['SAVE']),
    }
  }

  async fetchAudience(
    _account: Account,
    credential: Credential
  ): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>(
      `/user_account/analytics?start_date=${isoDate(daysAgo(30))}` +
        `&end_date=${isoDate(new Date())}&metric_types=IMPRESSION,SAVE`,
      credential.accessToken
    )
  }

  /**
   * Ends the grant at Pinterest, not merely locally.
   *
   * A disconnect that only forgets our copy leaves a live grant on the person's
   * Pinterest account that they did not ask to keep and cannot see us holding.
   */
  async revokeToken(credential: Credential): Promise<void> {
    const app = this.app()
    if (!app) return

    await fetch(`${API}/oauth/token/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.id}:${app.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: credential.accessToken }).toString(),
    }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------

  /**
   * Token exchange and refresh.
   *
   * Credentials go in a Basic header rather than the form body. Pinterest
   * accepts both, and a secret in a body that gets logged on failure is a
   * secret in a log.
   */
  private async token(form: Record<string, string>): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }> {
    assertOutsideTransaction('Pinterest token exchange')

    const app = this.app()
    if (!app) {
      throw new ProviderError(this.id, 'PermanentFailure', 'Pinterest app credentials are not set.')
    }

    const response = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.id}:${app.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    })

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      message?: string
    }

    if (!response.ok || !body.access_token) {
      throw new ProviderError(
        this.id,
        response.status === 401 ? 'TokenExpired' : 'PermanentFailure',
        body.message ?? `Pinterest refused the token request (HTTP ${response.status}).`,
        { httpStatus: response.status }
      )
    }

    return {
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(body.expires_in ? { expiresAt: new Date(Date.now() + body.expires_in * 1000) } : {}),
    }
  }

  private async call<T>(
    path: string,
    accessToken: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    assertOutsideTransaction(`Pinterest ${path}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)

    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      // Ambiguous for a publish: the pin may exist. ProviderDown is what the
      // pipeline reconciles against rather than retrying into a duplicate.
      throw new ProviderError(
        this.id,
        'ProviderDown',
        err instanceof Error && err.name === 'AbortError'
          ? 'Pinterest did not respond in time.'
          : 'Could not reach Pinterest.'
      )
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 204) return {} as T

    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: number }

    if (!response.ok) throw this.toError(response, body)

    return body as T
  }

  private toError(response: Response, body: { message?: string; code?: number }): ProviderError {
    const detail = body.message ?? `HTTP ${response.status}`
    const options = { httpStatus: response.status, raw: body }

    if (response.status === 401) {
      return new ProviderError(this.id, 'TokenExpired', `Reconnect Pinterest: ${detail}`, options)
    }
    if (response.status === 403) {
      return new ProviderError(this.id, 'PermissionRevoked', detail, options)
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      return new ProviderError(this.id, 'RateLimited', detail, {
        ...options,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterSeconds: retryAfter }
          : {}),
      })
    }
    if (response.status >= 500) {
      return new ProviderError(this.id, 'ProviderDown', `Pinterest had a problem: ${detail}`, options)
    }

    return new ProviderError(this.id, 'ContentRejected', detail, options)
  }
}

// ---------------------------------------------------------------------------

function firstLine(body: string): string {
  const line = body.split('\n')[0] ?? ''
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}
