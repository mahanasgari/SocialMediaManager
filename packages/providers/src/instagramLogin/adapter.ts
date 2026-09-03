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
import {
  igAuthorizeUrl,
  igExchangeCode,
  igExchangeForLongLivedToken,
  igGraph,
  igRefreshToken,
  instagramApp,
} from '../meta/instagram-login.js'
import { capabilities, limits, media, text } from './capabilities.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Instagram, connected through Instagram rather than through Facebook.
 *
 * Same network, same publishing model, different door — and the door is the
 * whole point. The Facebook Login connector reaches an Instagram account by
 * walking the person's Pages and keeping the ones with a linked professional
 * account, which fails for everyone whose account is not linked to a Page they
 * administer. That is most people, and the resulting "no Instagram Business
 * account is linked to a Page you manage" is the single most common reason
 * connecting fails.
 *
 * Here the person signs in to Instagram and authorises one account. No Page.
 *
 * Three things follow, and they are why this is a separate connector rather
 * than a flag on the old one:
 *
 *   1. THE TOKEN EXPIRES AND REFRESHES. Sixty days, renewable without the
 *      person present. The Page-token connector cannot refresh at all — its
 *      refreshToken() throws and tells you to reconnect. One class cannot
 *      honestly implement both behaviours.
 *
 *   2. THERE ARE NO DMs HERE. Messaging in the old connector addresses
 *      /{pageId}/messages, and there is no Page to address. `dm` is declared
 *      false and no sendMessage method exists — the contract suite enforces
 *      that pairing in both directions, so the composer cannot render a control
 *      for something that would fail.
 *
 *   3. THE APP CREDENTIALS ARE DIFFERENT. Instagram App ID and Secret, not the
 *      Facebook ones.
 *
 * [V] Business Login flow, endpoints and scope format
 *     https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
 *     retrieved 2026-09-02
 */
export class InstagramLoginProvider implements AnyProvider {
  readonly id = 'instagramLogin' as const
  readonly label = 'Instagram (Instagram Login)'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

  /**
   * Only what this connector actually uses.
   *
   * `instagram_business_manage_messages` is deliberately NOT requested. It
   * would grant DM access this connector does not implement, and asking a
   * person to approve a permission that buys them nothing is both rude and a
   * reason for App Review to come back with questions.
   *
   * [V] instagram_business_basic, _content_publish, _manage_comments
   *     https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
   *     retrieved 2026-09-02
   * [V] instagram_business_manage_insights, for media and account insights
   *     https://developers.facebook.com/docs/instagram-platform/insights/
   *     retrieved 2026-09-02
   */
  private static readonly SCOPES = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_insights',
  ] as const

  private static readonly POLL_INTERVAL_MS = 3_000
  private static readonly POLL_TIMEOUT_MS = 5 * 60_000

  readonly notice =
    'Publishing, comments and insights each need Meta App Review before anyone outside ' +
    'your app’s test users can connect. Direct messages are not supported through this ' +
    'connector — use the Facebook Pages route if you need them.'

  isConfigured(): boolean {
    return instagramApp() !== null
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = instagramApp()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Instagram is not configured. Add an Instagram app ID and secret in ' +
          'Settings > Connector credentials, or set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET. ' +
          'These are the Instagram app credentials, not the Facebook ones.'
      )
    }

    return {
      url: igAuthorizeUrl({
        appId: app.appId,
        redirectUri: ctx.redirectUri,
        state: ctx.state,
        scopes: InstagramLoginProvider.SCOPES,
      }),
      state: ctx.state,
    }
  }

  /**
   * One account, not a list.
   *
   * The person authorised exactly one Instagram account, so unlike the Page
   * walk there is nothing to filter and no "which of these did you mean". The
   * short-lived token is exchanged for a long-lived one HERE, during the
   * connect flow, because the short one dies in an hour and there is no path
   * back to a long-lived token without the person authorising again.
   */
  async handleCallback(
    ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    if (params['error']) {
      // The person pressed Cancel, or Instagram refused. Their words, not ours.
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        params['error_description'] ?? 'Instagram did not authorise the connection.'
      )
    }

    const code = params['code']
    if (!code) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'Instagram did not return an authorization code.'
      )
    }

    const shortLived = await igExchangeCode(this.id, code, ctx.redirectUri)
    const longLived = await igExchangeForLongLivedToken(this.id, shortLived.accessToken)

    const profile = await igGraph<{
      user_id?: string
      username?: string
      name?: string
      account_type?: string
    }>(this.id, '/me', {
      query: { fields: 'user_id,username,name,account_type' },
      accessToken: longLived.accessToken,
    })

    const igId = profile.user_id ?? shortLived.userId
    if (!igId) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Instagram authorised the connection but did not say which account it was for.'
      )
    }

    return [
      {
        providerAccountId: igId,
        handle: profile.username ? `@${profile.username}` : igId,
        displayName: profile.name ?? profile.username ?? igId,
        credential: {
          accessToken: longLived.accessToken,
          scopes: [...InstagramLoginProvider.SCOPES],
          ...(longLived.expiresAt ? { expiresAt: longLived.expiresAt } : {}),
        },
        // No pageId, deliberately: there is no Page. Anything reading
        // platformMeta.pageId belongs to the other connector.
        platformMeta: {
          instagramId: igId,
          ...(profile.account_type ? { accountType: profile.account_type } : {}),
          loginFlow: 'instagram',
        },
      },
    ]
  }

  /**
   * Sixty more days, without the person being present.
   *
   * The window is real at both ends: a token under 24 hours old is refused, and
   * an expired one cannot be recovered at all. So the refresher has to run well
   * before day sixty — waiting until expiry means a reconnect, which needs a
   * human.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    const refreshed = await igRefreshToken(this.id, credential.accessToken)
    return {
      accessToken: refreshed.accessToken,
      scopes: credential.scopes,
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
    }
  }

  async fetchProfile(
    _account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const profile = await igGraph<{ username: string; name?: string }>(this.id, '/me', {
      query: { fields: 'username,name' },
      accessToken: credential.accessToken,
    })
    return { handle: `@${profile.username}`, displayName: profile.name ?? profile.username }
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
        message: 'Instagram posts must include at least one image or video.',
      })
    }

    return issues
  }

  /**
   * Create a container, wait for it, publish it.
   *
   * Identical in shape to the Facebook Login connector because the publishing
   * model is genuinely the same — only the host and the token differ. Instagram
   * still PULLS the media from a URL its servers must reach, which is what
   * MEDIA_PUBLIC_MODE and the signed relay exist for.
   */
  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const token = credential.accessToken

    if (payload.media.length === 0) {
      throw new ProviderError(
        this.id,
        'ContentRejected',
        'Instagram posts must include at least one image or video.'
      )
    }

    const containerId =
      payload.media.length > 1
        ? await this.createCarousel(token, payload)
        : await this.createSingle(token, payload)

    await this.awaitContainer(token, containerId)

    const published = await igGraph<{ id: string }>(this.id, '/me/media_publish', {
      method: 'POST',
      accessToken: token,
      body: { creation_id: containerId },
    })

    // No remoteUrl: Instagram's permalink needs a second call, and one built
    // from the media id 404s. A broken link reads as a deleted post.
    return { remoteId: published.id, providerRequestId: containerId }
  }

  private async createSingle(token: string, payload: PublishPayload): Promise<string> {
    const asset = payload.media[0]!
    const isVideo = asset.mime.startsWith('video/')

    const container = await igGraph<{ id: string }>(this.id, '/me/media', {
      method: 'POST',
      accessToken: token,
      body: {
        ...(isVideo ? { video_url: asset.url } : { image_url: asset.url }),
        // REELS, not VIDEO: standalone feed video is retired and a VIDEO
        // container is converted silently. Being explicit keeps the surface we
        // validated against and the surface published the same.
        ...(isVideo ? { media_type: payload.surface === 'story' ? 'STORIES' : 'REELS' } : {}),
        ...(!isVideo && payload.surface === 'story' ? { media_type: 'STORIES' } : {}),
        caption: payload.text,
        ...(asset.altText ? { alt_text: asset.altText } : {}),
      },
    })

    return container.id
  }

  /**
   * A carousel: a container per item, then one holding them.
   *
   * `is_carousel_item` is what stops each child publishing as a post in its own
   * right. Without it a two-image carousel becomes two separate posts, which is
   * immediately visible and cannot be undone without deleting both.
   */
  private async createCarousel(token: string, payload: PublishPayload): Promise<string> {
    const children: string[] = []

    for (const asset of payload.media) {
      const isVideo = asset.mime.startsWith('video/')
      const child = await igGraph<{ id: string }>(this.id, '/me/media', {
        method: 'POST',
        accessToken: token,
        body: {
          ...(isVideo ? { video_url: asset.url } : { image_url: asset.url }),
          is_carousel_item: 'true',
          ...(asset.altText ? { alt_text: asset.altText } : {}),
        },
      })
      children.push(child.id)
    }

    for (const child of children) await this.awaitContainer(token, child)

    const parent = await igGraph<{ id: string }>(this.id, '/me/media', {
      method: 'POST',
      accessToken: token,
      body: {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: payload.text,
      },
    })

    return parent.id
  }

  /**
   * Waits for a container to reach FINISHED.
   *
   * PUBLISHED is treated as success rather than as an error, and that is the
   * reconciliation case: if an earlier attempt published and we never saw the
   * response, publishing again would duplicate a live post. Returning here is
   * what prevents that.
   *
   * [V] status_code values and "once per minute, for no more than 5 minutes"
   *     https://developers.facebook.com/docs/instagram-platform/content-publishing
   *     retrieved 2026-09-02
   */
  private async awaitContainer(token: string, containerId: string): Promise<void> {
    const deadline = Date.now() + InstagramLoginProvider.POLL_TIMEOUT_MS

    for (;;) {
      const status = await igGraph<{ status_code?: string; status?: string }>(
        this.id,
        `/${containerId}`,
        { query: { fields: 'status_code,status' }, accessToken: token }
      )

      switch (status.status_code) {
        case 'FINISHED':
        case 'PUBLISHED':
          return

        case 'ERROR':
          throw new ProviderError(
            this.id,
            'InvalidMedia',
            `Instagram could not process this media: ${status.status ?? 'no detail given'}`
          )

        case 'EXPIRED':
          throw new ProviderError(
            this.id,
            'PermanentFailure',
            'The upload expired before it could be published.'
          )

        default:
          break
      }

      if (Date.now() >= deadline) {
        // ProviderDown rather than a failure: the container may still finish,
        // so this must reconcile rather than retry into a duplicate.
        throw new ProviderError(
          this.id,
          'ProviderDown',
          'Instagram is still processing this media after five minutes.'
        )
      }

      await sleep(InstagramLoginProvider.POLL_INTERVAL_MS)
    }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    await igGraph(this.id, `/${remoteId}`, {
      method: 'DELETE',
      accessToken: credential.accessToken,
    })
  }

  async retrievePosts(
    _account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const body = await igGraph<{
      data?: Array<{
        id: string
        caption?: string
        timestamp: string
        children?: { data?: unknown[] }
      }>
    }>(this.id, '/me/media', {
      query: {
        fields: 'id,caption,timestamp,media_type,children{id}',
        // Instagram ignores `since` on this edge, so the window is applied
        // locally. Pretending the parameter worked would return everything.
        limit: '25',
      },
      accessToken: credential.accessToken,
    })

    const cutoff = since.getTime() - 60_000
    return (body.data ?? [])
      .map((post) => ({
        remoteId: post.id,
        createdAt: new Date(post.timestamp),
        text: post.caption ?? '',
        mediaCount: post.children?.data?.length ?? 1,
      }))
      .filter((post) => post.createdAt.getTime() >= cutoff)
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const body = await igGraph<{
      data?: Array<{ name: string; values?: Array<{ value: number }> }>
    }>(this.id, `/${remoteId}/insights`, {
      query: { metric: 'impressions,reach,likes,comments,saved,shares' },
      accessToken: credential.accessToken,
    })

    const raw = new Map<string, number>()
    for (const entry of body.data ?? []) {
      const value = entry.values?.[0]?.value
      if (typeof value === 'number') raw.set(entry.name, value)
    }

    // Nullable throughout: Instagram omits metrics that do not apply to a media
    // type rather than returning zero, and flattening that to 0 reports
    // engagement nobody measured.
    return {
      impressions: raw.get('impressions') ?? null,
      reach: raw.get('reach') ?? null,
      likes: raw.get('likes') ?? null,
      comments: raw.get('comments') ?? null,
      saves: raw.get('saved') ?? null,
      shares: raw.get('shares') ?? null,
    }
  }

  async fetchAudience(_account: Account, credential: Credential): Promise<Record<string, unknown>> {
    const body = await igGraph<{
      data?: Array<{ name: string; values?: Array<{ value: unknown }> }>
    }>(this.id, '/me/insights', {
      query: { metric: 'follower_count,reach', period: 'day' },
      accessToken: credential.accessToken,
    })

    const out: Record<string, unknown> = {}
    for (const entry of body.data ?? []) out[entry.name] = entry.values?.[0]?.value
    return out
  }

  async fetchComments(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<unknown[]> {
    const body = await igGraph<{ data?: unknown[] }>(this.id, `/${remoteId}/comments`, {
      query: { fields: 'id,text,timestamp,username,replies{id,text,username}', limit: '100' },
      accessToken: credential.accessToken,
    })
    return body.data ?? []
  }

  async replyToComment(
    _account: Account,
    credential: Credential,
    objectId: string,
    message: string
  ): Promise<{ id: string }> {
    return igGraph<{ id: string }>(this.id, `/${objectId}/replies`, {
      method: 'POST',
      accessToken: credential.accessToken,
      body: { message },
    })
  }
}
