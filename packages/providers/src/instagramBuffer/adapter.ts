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
import { assetsFor, channelsOfService, toRemotePost } from '../buffer/route.js'
import { createPost, listChannels, listPosts, postMetrics } from '../buffer/client.js'

/**
 * Instagram via Buffer.
 *
 * The publishing path is Buffer's; the RULES are Instagram's. A caption still
 * cannot exceed 2,200 characters and a feed image still has to sit between 4:5
 * and 1.91:1, because the post lands on Instagram either way and Buffer will not
 * save anyone from Instagram's refusal — it will simply relay it later, after
 * the post has left our queue and become someone else's problem to debug.
 *
 * See ./capabilities.ts for what this route cannot do, which is a longer list
 * than what it can.
 */
export class InstagramBufferProvider implements AnyProvider {
  readonly id = 'instagramBuffer' as const
  readonly network = 'instagram' as const
  readonly label = 'Instagram (via Buffer)'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

  /**
   * Always available: the key belongs to the workspace, not the deployment.
   *
   * Nothing for an administrator to configure, which is the point of the route.
   * Meta's app credentials gate the direct connectors; this one is gated only on
   * someone having a Buffer account.
   */
  isConfigured(): boolean {
    return true
  }

  readonly authStyle = 'credentials' as const

  readonly notice =
    'Publishing and metrics only. This route cannot read comments or DMs, so the inbox stays ' +
    'empty for it, and posts cannot be edited or deleted from here once sent. Images must be on ' +
    'a publicly reachable URL for Buffer to fetch them.'

  readonly connectFields = [
    {
      name: 'apiKey',
      label: 'Buffer API key',
      type: 'password' as const,
      placeholder: '1/abc123...',
      hint: 'In Buffer, open Settings → API and create a key. It reaches every channel on that Buffer account, so use a key from the account that owns the Instagram channel you want.',
    },
  ]

  async getAuthUrl(_ctx: AuthContext): Promise<AuthRedirect> {
    throw new ProviderError(
      'instagramBuffer',
      'PermanentFailure',
      'This route connects with a Buffer API key rather than a redirect. Create one under ' +
        'Settings → API in Buffer and paste it here.'
    )
  }

  /**
   * Turns one key into one connectable account per Instagram channel.
   *
   * The key is stored on every account it discovers rather than once for the
   * workspace. That looks like duplication and is deliberate: credentials are
   * already encrypted per account, so this route inherits that storage, its
   * rotation and its revocation without a second secret store — and
   * disconnecting one channel cannot strand the others.
   */
  async handleCallback(
    _ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const apiKey = params['apiKey']?.trim()
    if (!apiKey) {
      throw new ProviderError('instagramBuffer', 'PermanentFailure', 'A Buffer API key is required.')
    }

    const channels = await listChannels('instagramBuffer', apiKey)
    const instagram = channelsOfService(channels, 'instagram')

    if (instagram.length === 0) {
      // Distinguishes "the key works but has no Instagram" from "the key is
      // wrong", which the transport would already have raised as a 401. Without
      // this the person retypes a perfectly good key.
      throw new ProviderError(
        'instagramBuffer',
        'PermanentFailure',
        channels.length === 0
          ? 'That Buffer account has no channels connected. Connect Instagram inside Buffer first, then use this key.'
          : `That Buffer account has ${channels.length} channel(s), but no Instagram one. Connect Instagram inside Buffer first.`
      )
    }

    return instagram.map((channel) => ({
      providerAccountId: channel.id,
      handle: channel.name.startsWith('@') ? channel.name : `@${channel.name}`,
      displayName: channel.displayName ?? channel.name,
      ...(channel.avatar ? { avatarUrl: channel.avatar } : {}),
      platformMeta: { bufferChannelId: channel.id, service: channel.service },
      credential: { accessToken: apiKey, scopes: ['buffer'] },
    }))
  }

  /**
   * Buffer API keys do not expire.
   *
   * Returns the credential unchanged rather than throwing, for the reason the
   * Telegram adapter gives: the refresher sweeps every account on a schedule,
   * and an adapter that throws for a token that is simply eternal produces a
   * permanent, meaningless error on the accounts page.
   */
  async refreshToken(credential: Credential): Promise<TokenSet> {
    return { accessToken: credential.accessToken, scopes: credential.scopes }
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const channels = await listChannels('instagramBuffer', credential.accessToken)
    const mine = channels.find((channel) => channel.id === account.providerAccountId)

    if (!mine) {
      // The channel was removed inside Buffer. That is a broken connection, and
      // saying so sends the account to NEEDS_REAUTH rather than retrying.
      throw new ProviderError(
        'instagramBuffer',
        'PermissionRevoked',
        'This Instagram channel is no longer on the Buffer account this key belongs to. Reconnect it in Buffer, or connect the channel here again.'
      )
    }

    return {
      handle: mine.name.startsWith('@') ? mine.name : `@${mine.name}`,
      displayName: mine.displayName ?? mine.name,
    }
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
    // Instagram will not accept a post with no media, and Buffer relays that
    // refusal rather than preventing it — so it is caught here, where the
    // message can name the actual problem instead of quoting a Meta error code
    // that arrives hours later.
    if (payload.media.length === 0) {
      throw new ProviderError(
        'instagramBuffer',
        'ContentRejected',
        'Instagram posts need an image or a video. Add media before scheduling this one.'
      )
    }

    // Buffer has no idempotency header. A duplicate is prevented instead by
    // retrievePosts: a lost response is reconciled by reading the channel back,
    // which is why that capability is true here and false on Telegram.
    void payload.idempotencyKey

    const post = await createPost('instagramBuffer', credential.accessToken, {
      channelId: account.providerAccountId,
      text: payload.text,
      assets: assetsFor(payload.media),
    })

    return {
      remoteId: post.id,
      // Buffer's own id. `externalLink` is the Instagram permalink and exists
      // only once Buffer has actually sent the post, so it is passed through
      // when present and omitted otherwise — a dead link on the posts list is
      // worse than no link.
      ...(post.externalLink ? { remoteUrl: post.externalLink } : {}),
      pending: post.status !== 'sent',
    }
  }

  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const posts = await listPosts(
      'instagramBuffer',
      credential.accessToken,
      account.providerAccountId
    )
    return posts.map(toRemotePost).filter((post) => post.createdAt >= since)
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    return postMetrics('instagramBuffer', credential.accessToken, remoteId)
  }
}
