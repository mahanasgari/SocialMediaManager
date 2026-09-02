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
import { providerSetting } from '../settings.js'

const API = 'https://api.linkedin.com'
const OAUTH = 'https://www.linkedin.com/oauth/v2'

/**
 * LinkedIn — personal profiles.
 *
 * Self-serve: the Share on LinkedIn product grants `w_member_social` with no
 * partner review, which is what makes this the cheapest real connector left.
 * Company Pages are a separate provider and need Marketing Developer Platform
 * approval, which is a manual review.
 *
 * Four things here are unlike every other connector in this system:
 *
 *   1. THE POST ID IS IN A HEADER. A successful share returns 201 with an empty
 *      body and the id in `X-RestLi-Id`. Parsing the body gets you nothing, and
 *      a connector that reads the body concludes the publish failed while the
 *      post is live — which is the exact shape that produces a duplicate.
 *
 *   2. THERE IS NO READ-BACK. `retrievePosts` is FALSE, not unimplemented. The
 *      self-serve tier grants no permission to read a member's own shares —
 *      that needs `r_member_social`, which is not self-serve. So this is the
 *      first connector where exactly-once is genuinely unachievable, and an
 *      ambiguous publish goes to NEEDS_REVIEW rather than being retried. The
 *      pipeline already handles that; LinkedIn is what makes it real rather
 *      than theoretical.
 *
 *   3. IMAGES ARE A THREE-STEP UPLOAD, and LinkedIn does not fetch from a URL.
 *      Register an asset, POST the bytes, then reference the returned URN.
 *
 *   4. THE MEMBER ID IS PAIRWISE. `sub` from the OIDC userinfo endpoint is
 *      specific to the app that asked, so the same person is a different id
 *      under a different LinkedIn app. Reconnect matching is already scoped to
 *      (workspace, provider, providerAccountId), so this is safe — but changing
 *      the app's client id orphans every connected account, and nothing will
 *      say so.
 *
 * [V] ugcPosts, X-Restli-Protocol-Version, the share schema, the three-step
 * upload and the 150/member/day throttle — retrieved 2026-08-31,
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 * [V] OIDC endpoints and the `sub` claim, retrieved 2026-08-31 —
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 */
export class LinkedInProvider implements AnyProvider {
  readonly id = 'linkedin' as const
  readonly label = 'LinkedIn'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  readonly notice =
    'LinkedIn’s self-serve tier can publish but cannot read your posts back, so if a publish ' +
    'is interrupted we cannot check whether it went out. Those posts are held for you to ' +
    'confirm rather than retried, because retrying could post twice.'

  /**
   * OIDC for identity, w_member_social for publishing.
   *
   * `openid` and `profile` replace the retired r_liteprofile. `email` is not
   * requested: nothing here uses an email address, and asking for one is asking
   * a person to hand over something for no reason.
   */
  private static readonly SCOPES = ['openid', 'profile', 'w_member_social'] as const

  isConfigured(): boolean {
    return this.app() !== null
  }

  private app(): { id: string; secret: string } | null {
    const id = providerSetting('LINKEDIN_CLIENT_ID')
    const secret = providerSetting('LINKEDIN_CLIENT_SECRET')
    if (!id || !secret) return null
    return { id, secret }
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = this.app()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'LinkedIn is not configured. Add a client ID and secret in Settings > Connectors, or set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.'
      )
    }

    const url = new URL(`${OAUTH}/authorization`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', app.id)
    url.searchParams.set('redirect_uri', ctx.redirectUri)
    url.searchParams.set('state', ctx.state)
    // Space-separated, unlike Meta and Pinterest which use commas. LinkedIn
    // silently drops a comma-joined list and the token comes back with no
    // permissions at all.
    url.searchParams.set('scope', LinkedInProvider.SCOPES.join(' '))

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
        params['error_description'] ?? 'LinkedIn did not return an authorization code.'
      )
    }

    const token = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
    })

    const profile = await this.call<{
      sub?: string
      name?: string
      given_name?: string
      family_name?: string
    }>('/v2/userinfo', token.accessToken)

    if (!profile.sub) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'LinkedIn returned no member id. Check that the app has Sign In with LinkedIn using OpenID Connect.'
      )
    }

    const name =
      profile.name ??
      [profile.given_name, profile.family_name].filter(Boolean).join(' ') ??
      'LinkedIn member'

    return [
      {
        providerAccountId: profile.sub,
        handle: name,
        displayName: name,
        credential: {
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
          scopes: [...LinkedInProvider.SCOPES],
        },
        // Stored built rather than assembled at publish time, so the one place
        // the URN shape is decided is here.
        platformMeta: { authorUrn: `urn:li:person:${profile.sub}` },
      },
    ]
  }

  /**
   * Refresh is available only to approved applications.
   *
   * A standard self-serve app gets a 60-day access token and NO refresh token,
   * so this throws rather than pretending. Saying "reconnect" is the truthful
   * answer, and a silent no-op here would leave the account looking healthy
   * while it quietly stopped working.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    if (!credential.refreshToken) {
      throw new ProviderError(
        this.id,
        'TokenExpired',
        'LinkedIn issues refresh tokens only to approved apps. Reconnect this account.'
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
    const profile = await this.call<{ name?: string; given_name?: string; family_name?: string }>(
      '/v2/userinfo',
      credential.accessToken
    )
    const name =
      profile.name ?? [profile.given_name, profile.family_name].filter(Boolean).join(' ')
    return { handle: name || 'LinkedIn member', displayName: name || 'LinkedIn member' }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const author = this.authorUrn(account)
    const token = credential.accessToken

    // Three shapes, and LinkedIn wants a different shareMediaCategory for each.
    // Getting it wrong is not an error — an IMAGE share with no media renders
    // as an empty card.
    const shareMedia =
      payload.media.length > 0
        ? await this.uploadAll(author, token, payload)
        : this.articleMedia(payload)

    const body = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: payload.text },
          shareMediaCategory: shareMedia.category,
          ...(shareMedia.media.length > 0 ? { media: shareMedia.media } : {}),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibilityOf(
          payload.platformOptions?.['visibility']
        ),
      },
    }

    const response = await this.raw('/v2/ugcPosts', token, { method: 'POST', body })

    // THE ID IS IN A HEADER. A 201 comes back with an empty body, and a
    // connector that parses the body concludes the publish failed while the
    // post is live — which is exactly how a retry becomes a duplicate.
    const postUrn = response.headers.get('x-restli-id')
    if (!postUrn) {
      throw new ProviderError(
        this.id,
        'ProviderDown',
        'LinkedIn accepted the share but returned no post id.'
      )
    }

    return {
      remoteId: postUrn,
      remoteUrl: `https://www.linkedin.com/feed/update/${postUrn}/`,
      providerRequestId: postUrn,
    }
  }

  /** A link share: no upload, just the URL and its card. */
  private articleMedia(payload: PublishPayload): {
    category: string
    media: Array<Record<string, unknown>>
  } {
    const link = firstUrl(payload.text)
    if (!link) return { category: 'NONE', media: [] }

    return {
      category: 'ARTICLE',
      media: [
        {
          status: 'READY',
          originalUrl: link,
          ...(payload.title ? { title: { text: payload.title } } : {}),
        },
      ],
    }
  }

  /**
   * Registers, uploads and references each asset.
   *
   * Sequential rather than parallel on purpose: LinkedIn allows 150 requests
   * per member per day, and a nine-image post is already nineteen of them.
   * Firing them at once buys nothing — the publish still waits for the slowest —
   * and makes the throttle harder to reason about.
   */
  private async uploadAll(
    author: string,
    token: string,
    payload: PublishPayload
  ): Promise<{ category: string; media: Array<Record<string, unknown>> }> {
    const isVideo = payload.media[0]!.mime.startsWith('video/')
    const recipe = isVideo
      ? 'urn:li:digitalmediaRecipe:feedshare-video'
      : 'urn:li:digitalmediaRecipe:feedshare-image'

    const entries: Array<Record<string, unknown>> = []

    for (const asset of payload.media) {
      const registration = await this.call<{
        value?: {
          asset?: string
          uploadMechanism?: {
            'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'?: { uploadUrl?: string }
          }
        }
      }>('/v2/assets?action=registerUpload', token, {
        method: 'POST',
        body: {
          registerUploadRequest: {
            recipes: [recipe],
            owner: author,
            serviceRelationships: [
              { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
            ],
          },
        },
      })

      const uploadUrl =
        registration.value?.uploadMechanism?.[
          'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
        ]?.uploadUrl
      const assetUrn = registration.value?.asset

      if (!uploadUrl || !assetUrn) {
        throw new ProviderError(
          this.id,
          'ProviderDown',
          'LinkedIn did not return an upload URL for this media.'
        )
      }

      // LinkedIn does not fetch from a URL, so the bytes come from our storage
      // and go straight out again — streamed rather than buffered, because a
      // worker that holds a video in memory to hand it on is a worker one large
      // post away from being OOM-killed.
      const source = await fetch(asset.url)
      if (!source.ok || !source.body) {
        throw new ProviderError(
          this.id,
          'InvalidMedia',
          `Could not read the media from storage (HTTP ${source.status}).`
        )
      }

      const upload = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': asset.mime,
          ...(source.headers.get('content-length')
            ? { 'content-length': source.headers.get('content-length')! }
            : {}),
        },
        body: source.body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

      if (!upload.ok) {
        throw new ProviderError(
          this.id,
          upload.status >= 500 ? 'ProviderDown' : 'InvalidMedia',
          `LinkedIn rejected the upload (HTTP ${upload.status}).`,
          { httpStatus: upload.status }
        )
      }

      entries.push({
        status: 'READY',
        media: assetUrn,
        ...(asset.altText ? { description: { text: asset.altText } } : {}),
      })
    }

    return { category: isVideo ? 'VIDEO' : 'IMAGE', media: entries }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    // The URN is already percent-unsafe — urn:li:share:123 contains colons —
    // so it is encoded rather than interpolated raw.
    await this.call(`/v2/ugcPosts/${encodeURIComponent(remoteId)}`, credential.accessToken, {
      method: 'DELETE',
    })
  }

  async revokeToken(credential: Credential): Promise<void> {
    const app = this.app()
    if (!app) return

    await fetch(`${OAUTH}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.id,
        client_secret: app.secret,
        token: credential.accessToken,
      }).toString(),
    }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------

  private authorUrn(account: Account): string {
    const stored = (account.platformMeta as { authorUrn?: string } | undefined)?.authorUrn
    return stored ?? `urn:li:person:${account.providerAccountId}`
  }

  private async token(form: Record<string, string>): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }> {
    assertOutsideTransaction('LinkedIn token exchange')

    const app = this.app()
    if (!app) {
      throw new ProviderError(this.id, 'PermanentFailure', 'LinkedIn app credentials are not set.')
    }

    const response = await fetch(`${OAUTH}/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...form,
        client_id: app.id,
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
        body.error_description ?? body.error ?? 'LinkedIn refused the token request.',
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
    const response = await this.raw(path, accessToken, options)
    if (response.status === 204) return {} as T
    return (await response.json().catch(() => ({}))) as T
  }

  /**
   * Returns the Response itself, because some answers live in headers.
   *
   * `call` is the convenience wrapper; publish needs the raw response to read
   * `X-RestLi-Id`.
   */
  private async raw(
    path: string,
    accessToken: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<Response> {
    assertOutsideTransaction(`LinkedIn ${path}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)

    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          // Required on every call. Without it LinkedIn answers with a
          // protocol-version error that names nothing useful.
          'x-restli-protocol-version': '2.0.0',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      throw new ProviderError(
        this.id,
        'ProviderDown',
        err instanceof Error && err.name === 'AbortError'
          ? 'LinkedIn did not respond in time.'
          : 'Could not reach LinkedIn.'
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) throw await this.toError(response)
    return response
  }

  private async toError(response: Response): Promise<ProviderError> {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string
      serviceErrorCode?: number
    }
    const detail = body.message ?? `HTTP ${response.status}`
    const options = { httpStatus: response.status, raw: body }

    if (response.status === 401) {
      return new ProviderError(this.id, 'TokenExpired', `Reconnect LinkedIn: ${detail}`, options)
    }
    if (response.status === 403) {
      return new ProviderError(
        this.id,
        'PermissionRevoked',
        `LinkedIn refused this: ${detail}. Check the app has the Share on LinkedIn product.`,
        options
      )
    }
    if (response.status === 429) {
      // LinkedIn's throttle is a daily window, not a burst — so a short retry
      // is pointless. The pipeline's own backoff is left to handle it rather
      // than guessing a Retry-After LinkedIn did not send.
      return new ProviderError(
        this.id,
        'RateLimited',
        `LinkedIn's daily limit for this member is spent. ${detail}`,
        options
      )
    }
    if (response.status >= 500) {
      return new ProviderError(this.id, 'ProviderDown', `LinkedIn had a problem: ${detail}`, options)
    }

    return new ProviderError(this.id, 'ContentRejected', detail, options)
  }
}

// ---------------------------------------------------------------------------

/** PUBLIC unless the author asked for connections-only. */
function visibilityOf(value: unknown): 'PUBLIC' | 'CONNECTIONS' {
  return value === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC'
}

function firstUrl(body: string): string | undefined {
  const match = /https?:\/\/[^\s<>"']+/.exec(body)
  if (!match) return undefined
  // Trailing sentence punctuation is not part of the URL, and LinkedIn will
  // happily build a card for a link that 404s.
  return match[0].replace(/[.,;:!?)]+$/, '')
}
