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

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3'

/**
 * YouTube.
 *
 * The one connector here that must move the BYTES itself. Meta, Pinterest and
 * the rest fetch media from a URL we hand them; YouTube does not, so this
 * adapter downloads from our storage and uploads to Google. That single
 * difference drives most of what follows.
 *
 *   1. RESUMABLE UPLOAD, IN TWO STEPS. A POST carrying only metadata returns a
 *      session URL in the Location header; the bytes go to that URL. The video
 *      id comes back from the second call, so a failure between them leaves
 *      nothing published and nothing to reconcile against — which is the good
 *      case, and the reason it is done this way rather than as one multipart
 *      request.
 *
 *   2. PRIVACY IS EXPLICIT AND DEFAULTS TO PRIVATE. A missing privacyStatus is
 *      not an error and not public; it simply publishes something nobody can
 *      see. It is always sent, and `private` is the default here rather than
 *      `public`, because the recoverable mistake is a video nobody saw yet.
 *
 *   3. QUOTA IS THE BINDING CONSTRAINT, NOT RATE. See limits.ts — the budget
 *      exists because discovering the ceiling by hitting it costs a day of
 *      publishing, not a retry.
 *
 * [V] videos.insert endpoint, parts, privacyStatus and the Video Uploads quota
 * bucket (1 unit, 100 calls/day), retrieved 2026-08-31 —
 * https://developers.google.com/youtube/v3/docs/videos/insert
 *
 * That SUPERSEDES the 1600-units-of-10,000 figure the plan recorded on
 * 2026-08-29: uploads have since moved to their own bucket.
 */
export class YouTubeProvider implements AnyProvider {
  readonly id = 'youtube' as const
  readonly label = 'YouTube'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  private static readonly SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    // force-ssl is what permits comment reads and replies. Without it the
    // comment capabilities declared in capabilities.ts would be dead methods.
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ] as const

  isConfigured(): boolean {
    return this.app() !== null
  }

  private app(): { id: string; secret: string } | null {
    const id = process.env['GOOGLE_CLIENT_ID']
    const secret = process.env['GOOGLE_CLIENT_SECRET']
    if (!id || !secret) return null
    return { id, secret }
  }

  /**
   * Google's consent screen, asked for offline access.
   *
   * `access_type=offline` with `prompt=consent` is what makes Google return a
   * REFRESH token. Without both, a second authorization returns only an access
   * token that dies in an hour, and the account silently stops publishing the
   * next day — the classic Google OAuth mistake, and invisible in testing
   * because the first authorization does return one.
   */
  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = this.app()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect YouTube.'
      )
    }

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', app.id)
    url.searchParams.set('redirect_uri', ctx.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', YouTubeProvider.SCOPES.join(' '))
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
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
        params['error_description'] ?? 'Google did not return an authorization code.'
      )
    }

    const token = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
    })

    const channels = await this.call<{
      items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }>
    }>('/channels?part=snippet&mine=true', token.accessToken)

    const items = channels.items ?? []
    if (items.length === 0) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'This Google account has no YouTube channel. Create one, then connect again.'
      )
    }

    return items.map((channel) => ({
      providerAccountId: channel.id,
      handle: channel.snippet?.customUrl ?? channel.id,
      displayName: channel.snippet?.title ?? channel.id,
      credential: {
        accessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        scopes: [...YouTubeProvider.SCOPES],
      },
      platformMeta: { channelId: channel.id },
    }))
  }

  async refreshToken(credential: Credential): Promise<TokenSet> {
    if (!credential.refreshToken) {
      throw new ProviderError(
        this.id,
        'TokenExpired',
        'No refresh token is stored for this channel. Reconnect it.'
      )
    }

    const token = await this.token({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    })

    return {
      accessToken: token.accessToken,
      // Google does NOT return a new refresh token on refresh. Returning
      // undefined here would let a caller overwrite the stored one with
      // nothing, and the account would stop refreshing a day later.
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    }
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const body = await this.call<{
      items?: Array<{ snippet?: { title?: string; customUrl?: string } }>
    }>(`/channels?part=snippet&id=${account.providerAccountId}`, credential.accessToken)

    const snippet = body.items?.[0]?.snippet
    return {
      handle: snippet?.customUrl ?? account.providerAccountId,
      displayName: snippet?.title ?? account.providerAccountId,
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
        message: 'A YouTube post is a video upload, so it needs a video file.',
      })
    }

    return issues
  }

  /**
   * Uploads and publishes in one operation, because on YouTube they are one.
   *
   * The title deserves a note. YouTube truncates hard at 100 characters and
   * rejects titles containing angle brackets, so the first line is taken,
   * cleaned and cut — a rejected upload after transferring a gigabyte is an
   * expensive way to learn about a punctuation rule.
   */
  async publish(
    _account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const asset = payload.media[0]
    if (!asset) {
      throw new ProviderError(
        this.id,
        'ContentRejected',
        'A YouTube post is a video upload, so it needs a video file.'
      )
    }

    assertOutsideTransaction('YouTube upload')

    const privacy = privacyOf(payload.platformOptions?.['privacyStatus'])

    const metadata = {
      snippet: {
        title: youtubeTitle(payload.title ?? payload.text),
        description: payload.text,
        ...(Array.isArray(payload.platformOptions?.['tags'])
          ? { tags: payload.platformOptions['tags'] as string[] }
          : {}),
      },
      status: {
        // Always sent. A missing privacyStatus is not an error and not public:
        // it uploads something nobody can see, with no indication anywhere.
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    }

    // Step one: open a resumable session. Only metadata crosses the wire here,
    // so a rejection for a bad title costs nothing.
    const session = await fetch(
      `${UPLOAD}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          'content-type': 'application/json',
          'x-upload-content-type': asset.mime,
        },
        body: JSON.stringify(metadata),
      }
    )

    if (!session.ok) {
      throw await this.toError(session)
    }

    const location = session.headers.get('location')
    if (!location) {
      throw new ProviderError(
        this.id,
        'ProviderDown',
        'YouTube accepted the upload request but returned no session URL.'
      )
    }

    // Step two: the bytes. Fetched from our own storage and streamed straight
    // through — buffering a video in memory to hand it on is how a worker gets
    // OOM-killed by a single large post.
    const source = await fetch(asset.url)
    if (!source.ok || !source.body) {
      throw new ProviderError(
        this.id,
        'InvalidMedia',
        `Could not read the video from storage (HTTP ${source.status}).`
      )
    }

    const upload = await fetch(location, {
      method: 'PUT',
      headers: {
        'content-type': asset.mime,
        ...(source.headers.get('content-length')
          ? { 'content-length': source.headers.get('content-length')! }
          : {}),
      },
      body: source.body,
      // Required by Node when streaming a request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    if (!upload.ok) {
      throw await this.toError(upload)
    }

    const video = (await upload.json().catch(() => ({}))) as { id?: string }
    if (!video.id) {
      // The bytes went somewhere and we have no id. Ambiguous, so it must
      // reconcile rather than retry: a second upload is a duplicate video.
      throw new ProviderError(
        this.id,
        'ProviderDown',
        'YouTube accepted the upload but returned no video id.'
      )
    }

    return {
      remoteId: video.id,
      remoteUrl: `https://www.youtube.com/watch?v=${video.id}`,
      providerRequestId: video.id,
      // Processing continues after the upload returns. A video can still fail
      // transcoding or be blocked by Content ID after this point.
      pending: true,
    }
  }

  async editPost(
    _account: Account,
    credential: Credential,
    remoteId: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    // videos.update REPLACES the parts it is given, so snippet must be sent
    // whole. Sending only the description silently clears the title, and
    // categoryId is required whenever snippet is present.
    const current = await this.call<{
      items?: Array<{ snippet?: { categoryId?: string; title?: string } }>
    }>(`/videos?part=snippet&id=${remoteId}`, credential.accessToken)

    const categoryId = current.items?.[0]?.snippet?.categoryId ?? '22'

    await this.call(`/videos?part=snippet`, credential.accessToken, {
      method: 'PUT',
      body: {
        id: remoteId,
        snippet: {
          title: youtubeTitle(payload.title ?? payload.text),
          description: payload.text,
          categoryId,
        },
      },
    })

    return { remoteId, remoteUrl: `https://www.youtube.com/watch?v=${remoteId}` }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    await this.call(`/videos?id=${remoteId}`, credential.accessToken, { method: 'DELETE' })
  }

  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    // search.list costs 100 units against the general quota, which is why this
    // uses the channel's uploads PLAYLIST instead: same result, 1 unit.
    const channel = await this.call<{
      items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
    }>(`/channels?part=contentDetails&id=${account.providerAccountId}`, credential.accessToken)

    const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
    if (!uploads) return []

    const body = await this.call<{
      items?: Array<{
        snippet?: { title?: string; description?: string; publishedAt?: string; resourceId?: { videoId?: string } }
      }>
    }>(
      `/playlistItems?part=snippet&maxResults=25&playlistId=${uploads}`,
      credential.accessToken
    )

    const cutoff = since.getTime() - 60_000
    return (body.items ?? [])
      .map((item) => ({
        remoteId: item.snippet?.resourceId?.videoId ?? '',
        createdAt: new Date(item.snippet?.publishedAt ?? 0),
        // The DESCRIPTION, not the title: the reconciler fingerprints against
        // the text we published, and that is what went into the description.
        text: item.snippet?.description ?? '',
        mediaCount: 1,
      }))
      .filter((post) => post.remoteId && post.createdAt.getTime() >= cutoff)
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const body = await this.call<{
      items?: Array<{ statistics?: Record<string, string> }>
    }>(`/videos?part=statistics&id=${remoteId}`, credential.accessToken)

    const stats = body.items?.[0]?.statistics
    if (!stats) return { views: null, likes: null, comments: null }

    // YouTube returns these as STRINGS, and a channel that hides its like count
    // omits the field entirely rather than sending zero.
    return {
      views: count(stats['viewCount']),
      likes: count(stats['likeCount']),
      comments: count(stats['commentCount']),
    }
  }

  async fetchAudience(
    account: Account,
    credential: Credential
  ): Promise<Record<string, unknown>> {
    const body = await this.call<{
      items?: Array<{ statistics?: Record<string, string> }>
    }>(
      `/channels?part=statistics&id=${account.providerAccountId}`,
      credential.accessToken
    )
    return (body.items?.[0]?.statistics ?? {}) as Record<string, unknown>
  }

  async fetchComments(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<unknown[]> {
    const body = await this.call<{ items?: unknown[] }>(
      `/commentThreads?part=snippet,replies&maxResults=100&videoId=${remoteId}`,
      credential.accessToken
    )
    return body.items ?? []
  }

  async replyToComment(
    _account: Account,
    credential: Credential,
    parentId: string,
    body: string
  ): Promise<unknown> {
    return this.call<{ id: string }>('/comments?part=snippet', credential.accessToken, {
      method: 'POST',
      body: { snippet: { parentId, textOriginal: body } },
    })
  }

  async revokeToken(credential: Credential): Promise<void> {
    // Google's revocation endpoint, so the grant ends at Google rather than
    // only in our database.
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: credential.refreshToken ?? credential.accessToken,
      }).toString(),
    }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------

  private async token(form: Record<string, string>): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }> {
    assertOutsideTransaction('YouTube token exchange')

    const app = this.app()
    if (!app) {
      throw new ProviderError(this.id, 'PermanentFailure', 'Google client credentials are not set.')
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
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
      // invalid_grant is specifically a dead or revoked refresh token, and it
      // needs a different answer from a misconfigured client: one is the user's
      // to fix by reconnecting, the other is the operator's.
      const expired = body.error === 'invalid_grant'
      throw new ProviderError(
        this.id,
        expired ? 'TokenExpired' : 'PermanentFailure',
        body.error_description ?? body.error ?? `Google refused the token request.`,
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
    assertOutsideTransaction(`YouTube ${path}`)

    const response = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }).catch(() => null)

    if (!response) {
      throw new ProviderError(this.id, 'ProviderDown', 'Could not reach YouTube.')
    }

    if (response.status === 204) return {} as T
    if (!response.ok) throw await this.toError(response)

    return (await response.json().catch(() => ({}))) as T
  }

  /**
   * Maps a Google error onto the taxonomy.
   *
   * `quotaExceeded` and `rateLimitExceeded` are BOTH 403 and mean different
   * things: the first is a daily allowance that will not return until midnight
   * Pacific, the second is a burst limit measured in seconds. Treating them
   * alike either retries pointlessly for hours or gives up on a request that
   * would have worked a second later.
   */
  private async toError(response: Response): Promise<ProviderError> {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> }
    }
    const reason = body.error?.errors?.[0]?.reason
    const detail = body.error?.message ?? `HTTP ${response.status}`
    const options = { httpStatus: response.status, raw: body }

    if (response.status === 401) {
      return new ProviderError(this.id, 'TokenExpired', `Reconnect YouTube: ${detail}`, options)
    }

    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      return new ProviderError(
        this.id,
        'RateLimited',
        `The daily YouTube quota is spent. It resets at midnight Pacific time. ${detail}`,
        {
          ...options,
          // No point retrying sooner. Guessing a shorter backoff burns the
          // retry budget on requests that cannot succeed.
          retryAfterSeconds: secondsUntilPacificMidnight(),
        }
      )
    }

    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return new ProviderError(this.id, 'RateLimited', detail, options)
    }

    if (response.status === 403) {
      return new ProviderError(this.id, 'PermissionRevoked', detail, options)
    }

    if (response.status >= 500) {
      return new ProviderError(this.id, 'ProviderDown', `YouTube had a problem: ${detail}`, options)
    }

    return new ProviderError(this.id, 'ContentRejected', detail, options)
  }
}

// ---------------------------------------------------------------------------

/**
 * A title YouTube will accept.
 *
 * 100 characters, no angle brackets. A rejected upload after transferring a
 * gigabyte is an expensive way to learn about a punctuation rule.
 */
export function youtubeTitle(source: string): string {
  const line = (source.split('\n')[0] ?? '').replace(/[<>]/g, '').trim()
  if (line.length === 0) return 'Untitled'
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

/** Anything unrecognised becomes `private`: the recoverable mistake. */
function privacyOf(value: unknown): 'public' | 'private' | 'unlisted' {
  return value === 'public' || value === 'unlisted' ? value : 'private'
}

function count(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Seconds until the YouTube quota resets.
 *
 * Midnight Pacific, which is UTC-7 or UTC-8 depending on the date — so it is
 * computed from the zone rather than by subtracting a fixed offset, which would
 * be an hour wrong for half the year.
 */
export function secondsUntilPacificMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second')
  const remaining = 86_400 - elapsed
  // A minute of slack, so a retry scheduled exactly on the boundary does not
  // land a second early and spend a retry discovering the quota is still spent.
  return remaining + 60
}
