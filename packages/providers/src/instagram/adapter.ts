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
  RemotePost,
  TokenSet,
  WebhookVerification,
} from '../base.js'
import { ProviderError } from '../errors.js'
import { verifyHmac } from '../webhook-signature.js'
import {
  validateMedia,
  validateText,
  type ValidationIssue,
  type VariantDraft,
} from '../capabilities/index.js'
import {
  authorizeUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  graph,
  listManagedPages,
  metaApp,
} from '../meta/graph.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Instagram (Business and Creator accounts).
 *
 * The publish path here is unlike every other connector in this system, and the
 * differences are the whole reason the pipeline was built the way it was:
 *
 *   1. PUBLISHING IS TWO CALLS, AND THE FIRST ONE IS ASYNCHRONOUS. You create a
 *      media CONTAINER, then publish it. Between those, Instagram is fetching
 *      and transcoding — a container answers IN_PROGRESS until it is FINISHED,
 *      and publishing an unfinished container fails. So the adapter polls, and
 *      the poll is bounded rather than infinite.
 *
 *   2. INSTAGRAM FETCHES THE MEDIA FROM US. There is no upload. The URL handed
 *      over must be reachable from Meta's servers, which is exactly what
 *      MEDIA_PUBLIC_MODE and the signed relay exist for. A deployment with
 *      neither cannot publish images here at all, and says so at boot rather
 *      than at post time.
 *
 *   3. THE ACCOUNT IS REACHED THROUGH A FACEBOOK PAGE. There is no
 *      Instagram-only login for this API. Discovery walks the Pages and keeps
 *      the ones with a linked Instagram Business account — so `pageDiscovery`
 *      is declared false while the connect flow nonetheless goes through Pages.
 *
 *   4. THERE IS NO EDIT. A published post's caption cannot be changed through
 *      the API, which is why editPost is declared false rather than
 *      approximated by delete-and-repost — that would lose the post's URL,
 *      likes and comments, which is not an edit.
 *
 * [V] Container states, endpoints and the 100-posts-per-24-hours limit —
 * https://developers.facebook.com/docs/instagram-platform/content-publishing,
 * retrieved 2026-08-31.
 */
export class InstagramProvider implements AnyProvider {
  readonly id = 'instagram' as const
  readonly label = 'Instagram'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  private static readonly SCOPES = [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'instagram_manage_messages',
    'pages_show_list',
    'pages_read_engagement',
  ] as const

  /**
   * How long to wait for a container to finish processing.
   *
   * Meta's own guidance is to check once a minute for no more than five. A
   * video that has not finished by then is not going to, and blocking a worker
   * indefinitely on one post starves every other publish behind it.
   */
  private static readonly POLL_INTERVAL_MS = 5_000
  private static readonly POLL_TIMEOUT_MS = 5 * 60_000

  isConfigured(): boolean {
    return metaApp() !== null
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = metaApp()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Set META_APP_ID and META_APP_SECRET to connect an Instagram account.'
      )
    }

    return {
      url: authorizeUrl({
        appId: app.appId,
        redirectUri: ctx.redirectUri,
        state: ctx.state,
        scopes: InstagramProvider.SCOPES,
      }),
      state: ctx.state,
    }
  }

  /**
   * Finds Instagram accounts by walking the person's Facebook Pages.
   *
   * A Page without a linked Instagram Business account is skipped silently —
   * that is the normal case for most Pages, not an error worth reporting. What
   * IS worth reporting is finding no linked account at all, because the usual
   * cause is a Personal rather than Business Instagram account and the message
   * should say that instead of "no accounts found".
   */
  async handleCallback(
    ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const code = params['code']
    if (!code) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        params['error_description'] ?? 'Instagram did not return an authorization code.'
      )
    }

    const shortLived = await exchangeCode(this.id, code, ctx.redirectUri)
    const longLived = await exchangeForLongLivedToken(this.id, shortLived)
    const pages = await listManagedPages(this.id, longLived.accessToken)

    const linked = pages.filter((p) => p.instagramBusinessAccountId)
    if (linked.length === 0) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        'No Instagram Business or Creator account is linked to a Facebook Page you manage. ' +
          'A personal Instagram account cannot publish through the API — convert it in the ' +
          'Instagram app first, then link it to a Page.'
      )
    }

    const accounts: DiscoveredAccount[] = []
    for (const page of linked) {
      const igId = page.instagramBusinessAccountId!
      // The username is fetched rather than borrowed from the Page. They are
      // routinely different, and showing the Page name next to an Instagram
      // icon makes people connect the wrong account.
      const profile = await graph<{ username?: string; name?: string }>(this.id, `/${igId}`, {
        query: { fields: 'username,name' },
        accessToken: page.accessToken,
      }).catch(() => ({}) as { username?: string; name?: string })

      accounts.push({
        providerAccountId: igId,
        handle: profile.username ? `@${profile.username}` : page.name,
        displayName: profile.name ?? page.name,
        credential: {
          // The PAGE token is what authorises Instagram calls. There is no
          // separate Instagram token in this API.
          accessToken: page.accessToken,
          scopes: [...InstagramProvider.SCOPES],
        },
        platformMeta: { instagramId: igId, pageId: page.id },
      })
    }

    return accounts
  }

  async refreshToken(_credential: Credential): Promise<TokenSet> {
    throw new ProviderError(
      this.id,
      'TokenExpired',
      'Instagram uses a Facebook Page token, which does not refresh. Reconnect the account.'
    )
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const profile = await graph<{ username: string; name?: string }>(
      this.id,
      `/${account.providerAccountId}`,
      { query: { fields: 'username,name' }, accessToken: credential.accessToken }
    )
    return { handle: `@${profile.username}`, displayName: profile.name ?? profile.username }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    const issues = [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]

    // Instagram has no text-only post. Saying so in the composer beats
    // discovering it when a scheduled post fails at 9am.
    if (draft.media.length === 0) {
      issues.push({
        severity: 'error',
        code: 'media_required',
        message: 'Instagram posts must include at least one image or video.',
      })
    }

    return issues
  }

  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const ig = account.providerAccountId
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
        ? await this.createCarousel(ig, token, payload)
        : await this.createSingle(ig, token, payload)

    await this.awaitContainer(ig, token, containerId)

    const published = await graph<{ id: string }>(this.id, `/${ig}/media_publish`, {
      method: 'POST',
      accessToken: token,
      form: { creation_id: containerId },
    })

    // No remoteUrl. Instagram's own permalink needs a second call, and
    // constructing one from the media id gives a URL that 404s — a broken link
    // in the UI is worse than no link, because it looks like the post is gone.
    return {
      remoteId: published.id,
      providerRequestId: containerId,
    }
  }

  /** One image, video or reel. */
  private async createSingle(
    ig: string,
    token: string,
    payload: PublishPayload
  ): Promise<string> {
    const asset = payload.media[0]!
    const isVideo = asset.mime.startsWith('video/')

    const container = await graph<{ id: string }>(this.id, `/${ig}/media`, {
      method: 'POST',
      accessToken: token,
      form: {
        ...(isVideo ? { video_url: asset.url } : { image_url: asset.url }),
        // REELS rather than VIDEO: Instagram retired standalone feed video, and
        // a VIDEO container is silently converted anyway. Being explicit means
        // the surface we validated against is the surface that gets published.
        ...(isVideo ? { media_type: payload.surface === 'story' ? 'STORIES' : 'REELS' } : {}),
        ...(!isVideo && payload.surface === 'story' ? { media_type: 'STORIES' } : {}),
        caption: payload.text,
        ...(asset.altText ? { alt_text: asset.altText } : {}),
      },
      timeoutMs: 60_000,
    })

    return container.id
  }

  /**
   * A carousel: one container per item, then a container holding those.
   *
   * The children are created with `is_carousel_item` so they never appear as
   * posts of their own. Without it a two-image carousel publishes as two
   * separate posts, which is a mistake a person notices immediately and cannot
   * undo without deleting both.
   */
  private async createCarousel(
    ig: string,
    token: string,
    payload: PublishPayload
  ): Promise<string> {
    const children: string[] = []

    for (const asset of payload.media) {
      const isVideo = asset.mime.startsWith('video/')
      const child = await graph<{ id: string }>(this.id, `/${ig}/media`, {
        method: 'POST',
        accessToken: token,
        form: {
          ...(isVideo ? { video_url: asset.url } : { image_url: asset.url }),
          is_carousel_item: 'true',
          ...(asset.altText ? { alt_text: asset.altText } : {}),
        },
        timeoutMs: 60_000,
      })
      children.push(child.id)
    }

    // Every child must finish processing before the parent will accept them.
    for (const child of children) await this.awaitContainer(ig, token, child)

    const parent = await graph<{ id: string }>(this.id, `/${ig}/media`, {
      method: 'POST',
      accessToken: token,
      form: {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: payload.text,
      },
    })

    return parent.id
  }

  /**
   * Waits for a container to become FINISHED.
   *
   * The five states are not interchangeable and each needs its own answer:
   *
   *   FINISHED     ready — the only success.
   *   IN_PROGRESS  keep waiting.
   *   ERROR        Instagram rejected the media. Permanent; retrying an
   *                identical file forever is worse than failing once.
   *   EXPIRED      the container was never published within 24 hours. Not our
   *                case here, but reported honestly rather than as a timeout.
   *   PUBLISHED    already live. This is the reconciliation case: if a previous
   *                attempt published and we never saw the response, publishing
   *                again would duplicate it, so this returns rather than
   *                proceeding.
   */
  private async awaitContainer(ig: string, token: string, containerId: string): Promise<void> {
    const deadline = Date.now() + InstagramProvider.POLL_TIMEOUT_MS

    for (;;) {
      const status = await graph<{ status_code?: string; status?: string }>(
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
        // ProviderDown, not a failure: the container may yet finish and be
        // publishable, so this must reconcile rather than be retried blindly
        // into a duplicate.
        throw new ProviderError(
          this.id,
          'ProviderDown',
          'Instagram is still processing this media after five minutes.'
        )
      }

      await sleep(InstagramProvider.POLL_INTERVAL_MS)
    }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    await graph(this.id, `/${remoteId}`, {
      method: 'DELETE',
      accessToken: credential.accessToken,
    })
  }

  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const body = await graph<{
      data?: Array<{
        id: string
        caption?: string
        timestamp: string
        media_type?: string
        children?: { data?: unknown[] }
      }>
    }>(this.id, `/${account.providerAccountId}/media`, {
      query: {
        fields: 'id,caption,timestamp,media_type,children{id}',
        // Instagram ignores `since` on this edge, so the window is applied
        // locally. Asking for a bounded page and filtering is correct here;
        // pretending the parameter worked would silently return everything.
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
    const body = await graph<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
      this.id,
      `/${remoteId}/insights`,
      {
        query: { metric: 'impressions,reach,likes,comments,saved,shares' },
        accessToken: credential.accessToken,
      }
    )

    const raw = new Map<string, number>()
    for (const entry of body.data ?? []) {
      const value = entry.values?.[0]?.value
      if (typeof value === 'number') raw.set(entry.name, value)
    }

    // Nullable throughout. Instagram omits metrics that do not apply to a media
    // type rather than returning zero, and flattening that to 0 would report
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

  async fetchAudience(
    account: Account,
    credential: Credential
  ): Promise<Record<string, unknown>> {
    const body = await graph<{ data?: Array<{ name: string; values?: Array<{ value: unknown }> }> }>(
      this.id,
      `/${account.providerAccountId}/insights`,
      {
        query: { metric: 'follower_count,reach', period: 'day' },
        accessToken: credential.accessToken,
      }
    )

    const out: Record<string, unknown> = {}
    for (const entry of body.data ?? []) out[entry.name] = entry.values?.[0]?.value
    return out
  }

  async fetchComments(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<unknown[]> {
    const body = await graph<{ data?: unknown[] }>(this.id, `/${remoteId}/comments`, {
      query: { fields: 'id,text,timestamp,username,replies{id,text,username}', limit: '100' },
      accessToken: credential.accessToken,
    })
    return body.data ?? []
  }

  async replyToComment(
    _account: Account,
    credential: Credential,
    objectId: string,
    body: string
  ): Promise<unknown> {
    return graph<{ id: string }>(this.id, `/${objectId}/replies`, {
      method: 'POST',
      accessToken: credential.accessToken,
      form: { message: body },
    })
  }

  async sendMessage(
    account: Account,
    credential: Credential,
    conversationId: string,
    body: string
  ): Promise<unknown> {
    // Sent from the PAGE, which is what owns the Instagram inbox. Posting to
    // the Instagram id here returns a confusing permission error rather than
    // anything that names the real problem.
    const pageId = (account.platformMeta as { pageId?: string })?.pageId
    if (!pageId) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'This account has no linked Page id, so messages cannot be sent. Reconnect it.'
      )
    }

    return graph<{ message_id: string }>(this.id, `/${pageId}/messages`, {
      method: 'POST',
      accessToken: credential.accessToken,
      form: {
        recipient: JSON.stringify({ id: conversationId }),
        message: JSON.stringify({ text: body }),
        messaging_type: 'RESPONSE',
      },
    })
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const app = metaApp()
    if (!app) return { valid: false, reason: 'META_APP_SECRET is not set.' }

    const result = verifyHmac(raw, {
      secret: app.appSecret,
      signature: headers['x-hub-signature-256'],
      prefix: 'sha256=',
      algorithm: 'sha256',
    })

    return result.valid
      ? { valid: true, providerAccountId: null }
      : { valid: false, reason: result.reason }
  }

  parseWebhook(payload: unknown): InboundEventShape[] {
    const body = payload as {
      entry?: Array<{
        id?: string
        time?: number
        changes?: Array<{ field?: string; value?: Record<string, unknown> }>
        messaging?: Array<Record<string, unknown>>
      }>
    }

    const events: InboundEventShape[] = []

    for (const entry of body.entry ?? []) {
      // Comments arrive as `changes`; direct messages arrive as `messaging`.
      // Two shapes on one subscription, and treating them alike loses the
      // distinction between a public reply and a private one.
      for (const change of entry.changes ?? []) {
        if (change.field !== 'comments') continue
        const value = change.value ?? {}
        events.push({
          kind: 'COMMENT_THREAD',
          providerAccountId: String(entry.id ?? ''),
          providerConversationId: String((value['media'] as { id?: string })?.id ?? ''),
          providerMessageId: String(value['id'] ?? ''),
          authorHandle: String((value['from'] as { username?: string })?.username ?? 'unknown'),
          body: String(value['text'] ?? ''),
          providerCreatedAt: entry.time ? new Date(entry.time * 1000) : new Date(),
          ...(value['parent_id'] ? { parentProviderMessageId: String(value['parent_id']) } : {}),
        })
      }

      for (const message of entry.messaging ?? []) {
        const inner = message['message'] as { mid?: string; text?: string; is_echo?: boolean } | undefined
        // is_echo marks our OWN outbound message coming back. Filing it as
        // inbound would show every reply we send as a message from the customer.
        if (!inner || inner.is_echo) continue

        const sender = (message['sender'] as { id?: string })?.id ?? 'unknown'
        events.push({
          kind: 'DM',
          providerAccountId: String(entry.id ?? ''),
          providerConversationId: String(sender),
          providerMessageId: String(inner.mid ?? ''),
          authorHandle: String(sender),
          body: String(inner.text ?? ''),
          providerCreatedAt: message['timestamp']
            ? new Date(Number(message['timestamp']))
            : new Date(),
        })
      }
    }

    return events
  }

  async revokeToken(credential: Credential): Promise<void> {
    await graph(this.id, '/me/permissions', {
      method: 'DELETE',
      accessToken: credential.accessToken,
    }).catch(() => undefined)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
