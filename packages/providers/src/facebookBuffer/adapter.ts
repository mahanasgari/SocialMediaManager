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
 * Facebook Pages via Buffer.
 *
 * Structurally the twin of the Instagram route and deliberately not merged with
 * it: the two differ on whether media is required, on how links are treated and
 * on the character ceiling, and every one of those differences would become a
 * branch inside a shared class. The shared part — the transport and three small
 * helpers — is shared; the part that disagrees is written out.
 */
export class FacebookBufferProvider implements AnyProvider {
  readonly id = 'facebookBuffer' as const
  readonly network = 'facebook' as const
  readonly label = 'Facebook (via Buffer)'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

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
      hint: 'In Buffer, open Settings → API and create a key. It reaches every channel on that Buffer account, so use a key from the account that owns the Page you want.',
    },
  ]

  async getAuthUrl(_ctx: AuthContext): Promise<AuthRedirect> {
    throw new ProviderError(
      'facebookBuffer',
      'PermanentFailure',
      'This route connects with a Buffer API key rather than a redirect. Create one under ' +
        'Settings → API in Buffer and paste it here.'
    )
  }

  async handleCallback(
    _ctx: AuthContext,
    params: Record<string, string>
  ): Promise<DiscoveredAccount[]> {
    const apiKey = params['apiKey']?.trim()
    if (!apiKey) {
      throw new ProviderError('facebookBuffer', 'PermanentFailure', 'A Buffer API key is required.')
    }

    const channels = await listChannels('facebookBuffer', apiKey)
    const pages = channelsOfService(channels, 'facebook')

    if (pages.length === 0) {
      throw new ProviderError(
        'facebookBuffer',
        'PermanentFailure',
        channels.length === 0
          ? 'That Buffer account has no channels connected. Connect a Facebook Page inside Buffer first, then use this key.'
          : `That Buffer account has ${channels.length} channel(s), but no Facebook one. Connect a Page inside Buffer first.`
      )
    }

    return pages.map((channel) => ({
      providerAccountId: channel.id,
      handle: channel.name,
      displayName: channel.displayName ?? channel.name,
      ...(channel.avatar ? { avatarUrl: channel.avatar } : {}),
      platformMeta: { bufferChannelId: channel.id, service: channel.service },
      credential: { accessToken: apiKey, scopes: ['buffer'] },
    }))
  }

  async refreshToken(credential: Credential): Promise<TokenSet> {
    return { accessToken: credential.accessToken, scopes: credential.scopes }
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const channels = await listChannels('facebookBuffer', credential.accessToken)
    const mine = channels.find((channel) => channel.id === account.providerAccountId)

    if (!mine) {
      throw new ProviderError(
        'facebookBuffer',
        'PermissionRevoked',
        'This Page is no longer on the Buffer account this key belongs to. Reconnect it in Buffer, or connect the Page here again.'
      )
    }

    return { handle: mine.name, displayName: mine.displayName ?? mine.name }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  /**
   * No media check, unlike the Instagram route.
   *
   * A Facebook status update with text and nothing else is an ordinary post,
   * and refusing one here — by copying Instagram's rule, which is the easy
   * mistake when two connectors look alike — would block something the network
   * accepts perfectly well.
   */
  async publish(
    account: Account,
    credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    if (payload.text.trim().length === 0 && payload.media.length === 0) {
      throw new ProviderError(
        'facebookBuffer',
        'ContentRejected',
        'A Facebook post needs text, an image or a video.'
      )
    }

    void payload.idempotencyKey

    const assets = assetsFor(payload.media)
    const post = await createPost('facebookBuffer', credential.accessToken, {
      channelId: account.providerAccountId,
      text: payload.text,
      ...(assets && assets.length > 0 ? { assets } : {}),
    })

    return { remoteId: post.id, pending: post.status !== 'sent' }
  }

  async retrievePosts(
    account: Account,
    credential: Credential,
    since: Date
  ): Promise<RemotePost[]> {
    const posts = await listPosts(
      'facebookBuffer',
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
    return postMetrics('facebookBuffer', credential.accessToken, remoteId)
  }
}
