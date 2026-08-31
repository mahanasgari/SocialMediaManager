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

const API = 'https://open.tiktokapis.com/v2'

/**
 * TikTok.
 *
 * The audit restriction is the whole story here, and TikTok — unlike Pinterest —
 * gives a way to DETECT it rather than only warn about it.
 *
 * An unaudited app cannot publish anything the public can see. What makes that
 * dangerous is that it does not fail: the post is created, an id comes back,
 * and it reaches nobody. Scheduling a month of content into that is a month
 * quietly wasted.
 *
 * But `creator_info` returns `privacy_level_options` — the values this app is
 * actually permitted to use for this creator. An unaudited app gets a list
 * containing only SELF_ONLY. So instead of a static warning nobody reads, this
 * adapter QUERIES before every publish and refuses when the requested
 * visibility is not on offer, naming the audit as the reason. A refusal a
 * person can act on beats a success they cannot see.
 *
 * The same call is required anyway — TikTok mandates showing the creator their
 * options before posting — so this costs nothing extra.
 *
 * Two further operator prerequisites, both outside this code:
 *
 *   PULL_FROM_URL needs a VERIFIED DOMAIN. TikTok fetches the video from a URL,
 *   and will only fetch from a domain proven to belong to the app owner. On a
 *   self-hosted install that is the deployment's own hostname, which is why
 *   this connector cannot work behind a URL TikTok cannot reach.
 *
 *   PUBLISHING IS ASYNCHRONOUS. init returns a publish_id, not a video id. The
 *   video appears later, or fails later, which is why the result is `pending`
 *   and carries the publish id for the status poll.
 *
 * [V] Audit requirement before content visibility, and privacy_level_options
 * from creator_info — https://developers.tiktok.com/doc/content-posting-api-get-started,
 * retrieved 2026-08-31.
 */
export class TikTokProvider implements AnyProvider {
  readonly id = 'tiktok' as const
  readonly label = 'TikTok'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  readonly notice =
    'TikTok requires an app audit before anything posted through the API is visible to ' +
    'anyone but you. Until yours passes, posts are created successfully and reach nobody — ' +
    'this connector checks before each publish and refuses rather than posting into the void. ' +
    'TikTok also only fetches video from a domain you have verified with them.'

  private static readonly SCOPES = [
    'user.info.basic',
    'video.publish',
    'video.list',
  ] as const

  isConfigured(): boolean {
    return this.app() !== null
  }

  private app(): { key: string; secret: string } | null {
    const key = process.env['TIKTOK_CLIENT_KEY']
    const secret = process.env['TIKTOK_CLIENT_SECRET']
    if (!key || !secret) return null
    return { key, secret }
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = this.app()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to connect TikTok.'
      )
    }

    const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
    // client_key, not client_id. TikTok is the only provider here that names it
    // differently, and the error for getting it wrong is an unhelpful redirect.
    url.searchParams.set('client_key', app.key)
    url.searchParams.set('redirect_uri', ctx.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', TikTokProvider.SCOPES.join(','))
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
        params['error_description'] ?? 'TikTok did not return an authorization code.'
      )
    }

    const token = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
    })

    const profile = await this.call<{
      data?: { user?: { open_id?: string; display_name?: string; username?: string } }
    }>('/user/info/?fields=open_id,display_name,username', token.accessToken)

    const user = profile.data?.user
    if (!user?.open_id) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'TikTok did not return a user for this authorization.'
      )
    }

    return [
      {
        providerAccountId: user.open_id,
        handle: user.username ? `@${user.username}` : user.open_id,
        displayName: user.display_name ?? user.open_id,
        credential: {
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
          scopes: [...TikTokProvider.SCOPES],
        },
        platformMeta: { openId: user.open_id },
      },
    ]
  }

  async refreshToken(credential: Credential): Promise<TokenSet> {
    if (!credential.refreshToken) {
      throw new ProviderError(
        this.id,
        'TokenExpired',
        'No refresh token is stored for this TikTok account. Reconnect it.'
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
    const profile = await this.call<{
      data?: { user?: { display_name?: string; username?: string; open_id?: string } }
    }>('/user/info/?fields=open_id,display_name,username', credential.accessToken)

    const user = profile.data?.user
    return {
      handle: user?.username ? `@${user.username}` : (user?.open_id ?? 'unknown'),
      displayName: user?.display_name ?? 'TikTok',
    }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    const issues = [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]

    if (draft.media.length === 0) {
      issues.push({
        severity: 'error',
        code: 'media_required',
        message: 'A TikTok post needs a video.',
      })
    }

    return issues
  }

  /**
   * Publishes, after checking that the requested visibility is actually
   * available.
   *
   * The check is the point. Publishing without it succeeds on an unaudited app
   * and the video reaches nobody, with nothing anywhere reporting a problem.
   */
  async publish(
    _account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const asset = payload.media[0]
    if (!asset) {
      throw new ProviderError(this.id, 'ContentRejected', 'A TikTok post needs a video.')
    }

    const creator = await this.creatorInfo(credential)
    const requested = privacyOf(payload.platformOptions?.['privacyLevel'])

    if (!creator.options.includes(requested)) {
      const onlyPrivate = creator.options.length > 0 && creator.options.every((o) => o === 'SELF_ONLY')

      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        onlyPrivate
          ? 'TikTok will only accept private posts from this app, which means it has not passed ' +
            'TikTok’s audit yet. Publishing now would create a video nobody but you can see, so ' +
            'it has been refused instead.'
          : `TikTok does not permit ${requested} for this account. Available: ${creator.options.join(', ') || 'none'}.`
      )
    }

    const init = await this.call<{
      data?: { publish_id?: string }
      error?: { code?: string; message?: string }
    }>('/post/publish/video/init/', credential.accessToken, {
      method: 'POST',
      body: {
        post_info: {
          title: tiktokTitle(payload.title ?? payload.text),
          privacy_level: requested,
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
        },
        source_info: {
          // TikTok fetches the file. The domain must be verified with them,
          // which is an operator prerequisite this code cannot satisfy.
          source: 'PULL_FROM_URL',
          video_url: asset.url,
        },
      },
    })

    const publishId = init.data?.publish_id
    if (!publishId) {
      throw new ProviderError(
        this.id,
        'ProviderDown',
        init.error?.message ?? 'TikTok accepted the request but returned no publish id.'
      )
    }

    return {
      // The PUBLISH id, not a video id — TikTok has not made one yet. The
      // status poll turns this into a video id later.
      remoteId: publishId,
      providerRequestId: publishId,
      pending: true,
    }
  }

  /**
   * What this app is permitted to do for this creator.
   *
   * `privacy_level_options` is the honest signal: an unaudited app is offered
   * only SELF_ONLY. TikTok requires this call before posting anyway, so using
   * it as the gate costs nothing.
   */
  private async creatorInfo(
    credential: Credential
  ): Promise<{ options: string[]; nickname: string | null }> {
    const body = await this.call<{
      data?: { privacy_level_options?: string[]; creator_nickname?: string }
    }>('/post/publish/creator_info/query/', credential.accessToken, { method: 'POST' })

    return {
      options: body.data?.privacy_level_options ?? [],
      nickname: body.data?.creator_nickname ?? null,
    }
  }

  async retrievePosts(
    _account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const body = await this.call<{
      data?: { videos?: Array<{ id: string; create_time?: number; video_description?: string }> }
    }>('/video/list/?fields=id,create_time,video_description', credential.accessToken, {
      method: 'POST',
      body: { max_count: 20 },
    })

    const cutoff = since.getTime() - 60_000
    return (body.data?.videos ?? [])
      .map((video) => ({
        remoteId: video.id,
        // create_time is in SECONDS. Treating it as milliseconds puts every
        // post in 1970 and the reconciler matches nothing.
        createdAt: new Date((video.create_time ?? 0) * 1000),
        text: video.video_description ?? '',
        mediaCount: 1,
      }))
      .filter((video) => video.createdAt.getTime() >= cutoff)
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const body = await this.call<{
      data?: {
        videos?: Array<{
          view_count?: number
          like_count?: number
          comment_count?: number
          share_count?: number
        }>
      }
    }>(
      '/video/query/?fields=id,view_count,like_count,comment_count,share_count',
      credential.accessToken,
      { method: 'POST', body: { filters: { video_ids: [remoteId] } } }
    )

    const video = body.data?.videos?.[0]
    if (!video) return { views: null, likes: null, comments: null, shares: null }

    return {
      views: video.view_count ?? null,
      likes: video.like_count ?? null,
      comments: video.comment_count ?? null,
      shares: video.share_count ?? null,
    }
  }

  async revokeToken(credential: Credential): Promise<void> {
    const app = this.app()
    if (!app) return

    await fetch(`${API}/oauth/revoke/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: app.key,
        client_secret: app.secret,
        token: credential.accessToken,
      }).toString(),
    }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------

  private async token(form: Record<string, string>): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }> {
    assertOutsideTransaction('TikTok token exchange')

    const app = this.app()
    if (!app) {
      throw new ProviderError(this.id, 'PermanentFailure', 'TikTok app credentials are not set.')
    }

    const response = await fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...form,
        client_key: app.key,
        client_secret: app.secret,
      }).toString(),
    })

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }

    if (!response.ok || !body.access_token) {
      throw new ProviderError(
        this.id,
        body.error === 'invalid_grant' ? 'TokenExpired' : 'PermanentFailure',
        body.error_description ?? body.error ?? 'TikTok refused the token request.',
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
    assertOutsideTransaction(`TikTok ${path}`)

    const response = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }).catch(() => null)

    if (!response) {
      throw new ProviderError(this.id, 'ProviderDown', 'Could not reach TikTok.')
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string }
    }

    // TikTok returns HTTP 200 with an error object inside. Checking only the
    // status code would treat every failure as a success — and for a publish,
    // that means reporting a video that does not exist.
    const code = body.error?.code
    if (!response.ok || (code && code !== 'ok')) {
      throw this.toError(response.status, code, body.error?.message)
    }

    return body as T
  }

  private toError(status: number, code: string | undefined, message: string | undefined): ProviderError {
    const detail = message ?? code ?? `HTTP ${status}`
    const options = { httpStatus: status }

    if (code === 'access_token_invalid' || code === 'access_token_expired' || status === 401) {
      return new ProviderError(this.id, 'TokenExpired', `Reconnect TikTok: ${detail}`, options)
    }
    if (code === 'scope_not_authorized' || code === 'scope_permission_missed' || status === 403) {
      return new ProviderError(this.id, 'PermissionRevoked', detail, options)
    }
    if (code === 'rate_limit_exceeded' || status === 429) {
      return new ProviderError(this.id, 'RateLimited', detail, options)
    }
    if (code === 'url_ownership_unverified') {
      // Worth its own message: the fix is a domain verification in TikTok's
      // console, not anything in this application.
      return new ProviderError(
        this.id,
        'PermanentFailure',
        'TikTok will not fetch video from this domain. Verify the domain in your TikTok ' +
          'developer console before publishing.',
        options
      )
    }
    if (status >= 500) {
      return new ProviderError(this.id, 'ProviderDown', `TikTok had a problem: ${detail}`, options)
    }

    return new ProviderError(this.id, 'ContentRejected', detail, options)
  }
}

// ---------------------------------------------------------------------------

const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']

/** Defaults to public: on TikTok the visibility gate is checked before posting. */
function privacyOf(value: unknown): string {
  return typeof value === 'string' && PRIVACY.includes(value) ? value : 'PUBLIC_TO_EVERYONE'
}

/** TikTok captions cap at 2200 characters. */
export function tiktokTitle(source: string): string {
  const line = (source.split('\n')[0] ?? '').trim()
  return line.length > 2200 ? line.slice(0, 2197) + '...' : line
}
