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
  canPublish,
  exchangeCode,
  exchangeForLongLivedToken,
  graph,
  listManagedPages,
  metaApp,
} from '../meta/graph.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Facebook Pages.
 *
 * Three things about this API shape the adapter more than anything else:
 *
 *   1. YOU PUBLISH AS A PAGE, NOT AS A PERSON. The token that posts is a Page
 *      token derived from the user's token, and a Page token derived from a
 *      LONG-LIVED user token does not expire. Deriving one per publish would
 *      add a round trip and a second failure point to every post, so the Page
 *      token is what gets stored — and the user token is discarded once the
 *      Pages are discovered.
 *
 *   2. SEEING A PAGE IS NOT POSTING TO IT. `tasks` on /me/accounts says what
 *      this person may actually do. Connecting a Page without CREATE_CONTENT
 *      produces an account that looks connected and fails on the first
 *      scheduled post — days later, in front of an audience. So it is checked
 *      at connect time and refused there.
 *
 *   3. A MULTI-PHOTO POST IS NOT ONE CALL. Each photo is uploaded UNPUBLISHED
 *      to get an id, then all the ids are attached to a single feed post. The
 *      intermediate photos are real objects on the Page; if the feed call then
 *      fails, they are orphaned rather than rolled back, because Meta offers no
 *      transaction. That is why the failure path deletes them explicitly.
 */
export class FacebookProvider implements AnyProvider {
  readonly id = 'facebook' as const
  readonly label = 'Facebook Pages'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly authStyle = 'oauth' as const
  readonly connectFields = []

  /**
   * The minimum scopes for what this connector claims, and no more.
   *
   * An app requesting permissions it does not use fails App Review, and every
   * extra scope is one more thing a person has to agree to hand over. There is
   * no `pages_messaging` here because `dm` is declared false.
   */
  private static readonly SCOPES = [
    'pages_show_list',
    'pages_manage_posts',
    'pages_manage_engagement',
    'pages_read_engagement',
    'read_insights',
  ] as const

  isConfigured(): boolean {
    return metaApp() !== null
  }

  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const app = metaApp()
    if (!app) {
      throw new ProviderError(
        this.id,
        'PermanentFailure',
        'Set META_APP_ID and META_APP_SECRET to connect a Facebook Page.'
      )
    }

    return {
      url: authorizeUrl({
        appId: app.appId,
        redirectUri: ctx.redirectUri,
        state: ctx.state,
        scopes: FacebookProvider.SCOPES,
      }),
      state: ctx.state,
    }
  }

  /**
   * Returns one DiscoveredAccount per Page this person can publish to.
   *
   * The user token is exchanged for a long-lived one FIRST, because the Page
   * tokens are derived from whatever it is exchanged from: derive them from the
   * one-hour token Login returns and every Page token expires within the hour.
   * That works perfectly in testing and breaks for every user the next morning.
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
        params['error_description'] ?? 'Facebook did not return an authorization code.'
      )
    }

    const shortLived = await exchangeCode(this.id, code, ctx.redirectUri)
    const longLived = await exchangeForLongLivedToken(this.id, shortLived)
    const pages = await listManagedPages(this.id, longLived.accessToken)

    const publishable = pages.filter(canPublish)
    if (publishable.length === 0) {
      throw new ProviderError(
        this.id,
        'PermissionRevoked',
        pages.length === 0
          ? 'This account manages no Facebook Pages.'
          : 'You can see these Pages but not post to them. Ask a Page admin for the Create content task.'
      )
    }

    return publishable.map((page) => ({
      providerAccountId: page.id,
      handle: page.name,
      displayName: page.name,
      credential: {
        // The PAGE token. Derived from a long-lived user token, so it does not
        // expire — which is why there is no refresh path below.
        accessToken: page.accessToken,
        scopes: [...FacebookProvider.SCOPES],
      },
      platformMeta: { pageId: page.id, tasks: page.tasks },
    }))
  }

  /**
   * Page tokens do not expire, so there is nothing to refresh.
   *
   * Throwing rather than silently returning the same token: a caller that
   * believes it refreshed something when it did not will keep a dead
   * credential alive in its own bookkeeping. If a Page token stops working the
   * answer is reconnection, not refresh.
   */
  async refreshToken(_credential: Credential): Promise<TokenSet> {
    throw new ProviderError(
      this.id,
      'TokenExpired',
      'Facebook Page tokens do not refresh. Reconnect the Page.'
    )
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const page = await graph<{ id: string; name: string }>(
      this.id,
      `/${account.providerAccountId}`,
      { query: { fields: 'id,name' }, accessToken: credential.accessToken }
    )
    return { handle: page.name, displayName: page.name }
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
    const page = account.providerAccountId
    const token = credential.accessToken

    if (payload.media.length === 0) {
      return this.publishText(page, token, payload)
    }

    const isVideo = payload.media.every((m) => m.mime.startsWith('video/'))
    if (isVideo) return this.publishVideo(page, token, payload)

    return this.publishPhotos(page, token, payload)
  }

  /** Text, or text with a link preview. One call. */
  private async publishText(
    page: string,
    token: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const link = firstUrl(payload.text)

    const result = await graph<{ id: string }>(this.id, `/${page}/feed`, {
      method: 'POST',
      accessToken: token,
      form: {
        message: payload.text,
        // Supplied explicitly so Facebook renders the card for the link we
        // meant rather than whichever one it decides to scrape.
        ...(link ? { link } : {}),
      },
    })

    return {
      remoteId: result.id,
      remoteUrl: postUrl(result.id),
      providerRequestId: result.id,
    }
  }

  /**
   * One or more photos.
   *
   * A single photo can go straight to /photos. More than one has to be uploaded
   * unpublished first and then attached, and there is no transaction — so a
   * failure partway leaves real, invisible photo objects on the Page. They are
   * deleted explicitly, because the alternative is silent litter that counts
   * against storage and shows up in the Page's media library.
   */
  private async publishPhotos(
    page: string,
    token: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const [first, ...rest] = payload.media

    if (rest.length === 0 && first) {
      const result = await graph<{ id: string; post_id?: string }>(this.id, `/${page}/photos`, {
        method: 'POST',
        accessToken: token,
        form: {
          url: first.url,
          caption: payload.text,
          ...(first.altText ? { alt_text_custom: first.altText } : {}),
        },
      })
      // post_id is the FEED story; id is the photo object. The feed story is
      // what a person can open, so it is what gets stored.
      const remoteId = result.post_id ?? result.id
      return { remoteId, remoteUrl: postUrl(remoteId), providerRequestId: result.id }
    }

    const photoIds: string[] = []
    try {
      for (const asset of payload.media) {
        const uploaded = await graph<{ id: string }>(this.id, `/${page}/photos`, {
          method: 'POST',
          accessToken: token,
          form: {
            url: asset.url,
            published: 'false',
            ...(asset.altText ? { alt_text_custom: asset.altText } : {}),
          },
        })
        photoIds.push(uploaded.id)
      }

      const form: Record<string, string> = { message: payload.text }
      photoIds.forEach((id, index) => {
        form[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id })
      })

      const result = await graph<{ id: string }>(this.id, `/${page}/feed`, {
        method: 'POST',
        accessToken: token,
        form,
      })

      return { remoteId: result.id, remoteUrl: postUrl(result.id), providerRequestId: result.id }
    } catch (err) {
      // Best effort. If cleanup fails there is nothing further to do about it,
      // and the original error is the one worth reporting.
      await Promise.all(
        photoIds.map((id) =>
          graph(this.id, `/${id}`, { method: 'DELETE', accessToken: token }).catch(() => undefined)
        )
      )
      throw err
    }
  }

  /**
   * A video.
   *
   * Posted by URL rather than by upload, so Facebook fetches the bytes itself —
   * which is what makes MEDIA_PUBLIC_MODE load-bearing for this connector too,
   * not only Instagram's.
   *
   * The returned id is a VIDEO id, and the video is still processing when the
   * call returns. `pending` says so rather than reporting a publish that has
   * not happened yet.
   */
  private async publishVideo(
    page: string,
    token: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const video = payload.media[0]
    if (!video) throw new ProviderError(this.id, 'InvalidMedia', 'No video to publish.')

    const result = await graph<{ id: string }>(
      this.id,
      `https://graph-video.facebook.com/${page}/videos`,
      {
        method: 'POST',
        accessToken: token,
        form: { file_url: video.url, description: payload.text },
        // Uploads are fetched by Facebook from our URL; the call still blocks
        // while it does that, and a large file takes longer than the default.
        timeoutMs: 120_000,
      }
    )

    return {
      remoteId: result.id,
      remoteUrl: postUrl(result.id),
      providerRequestId: result.id,
      pending: true,
    }
  }

  async editPost(
    _account: Account,
    credential: Credential,
    remoteId: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    await graph(this.id, `/${remoteId}`, {
      method: 'POST',
      accessToken: credential.accessToken,
      form: { message: payload.text },
    })
    // The id does not change on edit, so the same one comes back rather than a
    // new one — a caller that stored it must not be told to store a different
    // value for the same post.
    return { remoteId, remoteUrl: postUrl(remoteId) }
  }

  async deletePost(_account: Account, credential: Credential, remoteId: string): Promise<void> {
    await graph(this.id, `/${remoteId}`, {
      method: 'DELETE',
      accessToken: credential.accessToken,
    })
  }

  /**
   * Recent posts, for reconciliation after an ambiguous publish.
   *
   * `since` is sent as a Unix timestamp because Graph rejects ISO strings on
   * this parameter, and the window is widened by a minute: the reconciler
   * compares against when WE started the call, and Facebook timestamps when IT
   * finished — so an exact boundary drops the very post being looked for.
   */
  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const body = await graph<{
      data?: Array<{ id: string; message?: string; created_time: string; attachments?: unknown }>
    }>(this.id, `/${account.providerAccountId}/posts`, {
      query: {
        fields: 'id,message,created_time,attachments{media_type}',
        since: String(Math.floor((since.getTime() - 60_000) / 1000)),
        limit: '50',
      },
      accessToken: credential.accessToken,
    })

    return (body.data ?? []).map((post) => ({
      remoteId: post.id,
      createdAt: new Date(post.created_time),
      text: post.message ?? '',
      mediaCount: countAttachments(post.attachments),
    }))
  }

  /**
   * Per-post metrics.
   *
   * Every value is nullable and stays null when Facebook does not return it.
   * The distinction is semantic: a measured zero is data, an absent metric is
   * not, and rendering "0 impressions" for something nobody counted is a lie
   * with a number attached.
   */
  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const body = await graph<{
      data?: Array<{ name: string; values?: Array<{ value: unknown }> }>
    }>(this.id, `/${remoteId}/insights`, {
      query: {
        metric: [
          'post_impressions',
          'post_impressions_unique',
          'post_clicks',
          'post_reactions_by_type_total',
        ].join(','),
      },
      accessToken: credential.accessToken,
    })

    const raw = new Map<string, unknown>()
    for (const entry of body.data ?? []) raw.set(entry.name, entry.values?.[0]?.value)

    const reactions = raw.get('post_reactions_by_type_total')
    const likes =
      reactions && typeof reactions === 'object'
        ? Object.values(reactions as Record<string, number>).reduce((a, b) => a + (b || 0), 0)
        : null

    return {
      impressions: numeric(raw.get('post_impressions')),
      reach: numeric(raw.get('post_impressions_unique')),
      clicks: numeric(raw.get('post_clicks')),
      likes,
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
        query: { metric: 'page_fans,page_fans_country,page_fans_city', period: 'day' },
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
      query: { fields: 'id,message,created_time,from{id,name}', limit: '100' },
      accessToken: credential.accessToken,
    })
    return body.data ?? []
  }

  /**
   * Replies to a comment, and also posts a first comment on a post.
   *
   * Both are POST /{object-id}/comments — Graph makes no distinction, because a
   * reply is a comment on a comment. One method rather than two saying the same
   * thing differently.
   */
  async replyToComment(
    _account: Account,
    credential: Credential,
    objectId: string,
    body: string
  ): Promise<unknown> {
    return graph<{ id: string }>(this.id, `/${objectId}/comments`, {
      method: 'POST',
      accessToken: credential.accessToken,
      form: { message: body },
    })
  }

  /**
   * Verifies an inbound webhook against the app secret.
   *
   * Over the RAW BYTES, never a re-serialised object. Re-encoding parsed JSON
   * produces a signature that passes on well-formed payloads and fails on
   * everything else — the single most common way this check appears to work
   * while protecting nothing.
   */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const app = metaApp()
    if (!app) return { valid: false, reason: 'META_APP_SECRET is not set.' }

    const header = headers['x-hub-signature-256']
    if (!header) return { valid: false, reason: 'Missing X-Hub-Signature-256.' }

    const result = verifyHmac(raw, {
      secret: app.appSecret,
      signature: header,
      // Meta prefixes the SIGNATURE with sha256=, it does not prepend anything
      // to the signed body. Passing this as signedPrefix instead silently signs
      // the wrong bytes and rejects every genuine delivery.
      prefix: 'sha256=',
      algorithm: 'sha256',
    })

    // providerAccountId stays null: the Page id lives in the payload, and this
    // function only sees bytes. Routing reads it after parsing, under the
    // inbound router's own narrow actor.
    return result.valid
      ? { valid: true, providerAccountId: null }
      : { valid: false, reason: result.reason }
  }

  parseWebhook(payload: unknown): InboundEventShape[] {
    const body = payload as {
      entry?: Array<{
        id?: string
        changes?: Array<{ field?: string; value?: Record<string, unknown> }>
      }>
    }

    const events: InboundEventShape[] = []
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'feed') continue
        const value = change.value ?? {}
        // A Page's own posts come back through the same subscription. Treating
        // them as inbound would file our own publishes as audience activity.
        if (value['item'] !== 'comment' || value['verb'] !== 'add') continue

        events.push({
          kind: 'COMMENT_THREAD',
          providerAccountId: String(entry.id ?? ''),
          // The POST is the conversation; each comment is a message in it. That
          // grouping is what makes a thread readable in the inbox rather than a
          // flat list of unrelated remarks.
          providerConversationId: String(value['post_id'] ?? ''),
          providerMessageId: String(value['comment_id'] ?? ''),
          authorHandle: String((value['from'] as { name?: string })?.name ?? 'unknown'),
          body: String(value['message'] ?? ''),
          // Facebook's own timestamp, in seconds. Never arrival time: webhook
          // delivery is out of order by design, and ordering by arrival puts
          // replies above the comments they answer.
          providerCreatedAt: value['created_time']
            ? new Date(Number(value['created_time']) * 1000)
            : new Date(),
          ...(value['parent_id'] ? { parentProviderMessageId: String(value['parent_id']) } : {}),
        })
      }
    }
    return events
  }

  /**
   * Revokes the app's access for this Page's owner.
   *
   * DELETE /{page-id}/permissions removes the grant at Meta rather than merely
   * forgetting the token locally. A disconnect that only deletes our copy
   * leaves a live grant on the user's Facebook account that they did not ask to
   * keep and cannot see us holding.
   */
  async revokeToken(credential: Credential): Promise<void> {
    await graph(this.id, '/me/permissions', {
      method: 'DELETE',
      accessToken: credential.accessToken,
    }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------

/** The first http(s) URL in the text, for an explicit link preview. */
function firstUrl(textBody: string): string | undefined {
  const match = /https?:\/\/[^\s<>"']+/.exec(textBody)
  if (!match) return undefined
  // Trailing sentence punctuation is not part of the URL, and including it
  // gives Facebook a link that 404s.
  return match[0].replace(/[.,;:!?)]+$/, '')
}

function postUrl(remoteId: string): string {
  return `https://www.facebook.com/${remoteId}`
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function countAttachments(attachments: unknown): number {
  const data = (attachments as { data?: unknown[] })?.data
  return Array.isArray(data) ? data.length : 0
}
