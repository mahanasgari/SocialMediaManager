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
import { ProviderError, type ProviderErrorCode } from '../errors.js'
import {
  validateMedia,
  validateText,
  type ValidationIssue,
  type VariantDraft,
} from '../capabilities/index.js'
import { capabilities, limits, media, text } from './capabilities.js'
import { detectFacets } from './facets.js'

const DEFAULT_SERVICE = 'https://bsky.social'

/**
 * Bluesky adapter.
 *
 * AT Protocol is unusual in two ways that shape this file:
 *
 *   1. There is no OAuth redirect for app passwords. A session is created by
 *      POSTing an identifier and an app password, which means `getAuthUrl` has
 *      nothing to redirect to — the connect UI collects credentials directly.
 *      OAuth exists and is recommended for new work, but app passwords are what
 *      a self-hoster can use today without registering anything.
 *
 *   2. Rich text is NOT parsed by the server. Links, mentions and hashtags only
 *      become clickable if we send byte-offset "facets" alongside the text — and
 *      those offsets are into UTF-8 BYTES, not JavaScript characters. Getting
 *      that wrong produces posts whose links silently do nothing.
 */
export class BlueskyProvider implements AnyProvider {
  readonly id = 'bluesky' as const
  readonly label = 'Bluesky'
  readonly state = 'implemented' as const
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text

  /**
   * App passwords, not OAuth.
   *
   * OAuth exists on AT Protocol and is recommended for new work, but app
   * passwords are what a self-hoster can use today without registering
   * anything — which is the whole reason Bluesky is reachable in this product
   * at all.
   */
  readonly authStyle = 'credentials' as const

  readonly connectFields = [
    {
      name: 'identifier',
      label: 'Handle',
      type: 'text' as const,
      placeholder: 'you.bsky.social',
      hint: 'Your full handle, without the leading @.',
    },
    {
      name: 'password',
      label: 'App password',
      type: 'password' as const,
      placeholder: 'xxxx-xxxx-xxxx-xxxx',
      // Says where to GET it, not what it is. Telling someone "an app password
      // is a password for an app" helps nobody.
      hint: 'Create one in Bluesky under Settings, Privacy and security, App passwords. Not your account password.',
    },
  ]

  constructor(private readonly serviceUrl: string = DEFAULT_SERVICE) {}

  /** Needs no operator credentials: each account supplies its own app password. */
  isConfigured(): boolean {
    return true
  }

  async getAuthUrl(_ctx: AuthContext): Promise<AuthRedirect> {
    throw new ProviderError(
      'bluesky',
      'PermanentFailure',
      'Bluesky connects with a handle and an app password rather than a redirect. ' +
        'Create an app password in Bluesky settings and enter it directly.'
    )
  }

  /**
   * Exchanges a handle and app password for a session.
   *
   * `params` carries the credentials rather than an authorization code, which is
   * why the interface takes a bag of strings instead of a typed callback shape:
   * not every provider does OAuth, and pretending otherwise would force this one
   * to fake a redirect it does not have.
   */
  async handleCallback(_ctx: AuthContext, params: Record<string, string>): Promise<DiscoveredAccount[]> {
    const identifier = params['identifier']
    const password = params['password']
    if (!identifier || !password) {
      throw new ProviderError(
        'bluesky',
        'PermanentFailure',
        'A Bluesky handle and app password are both required.'
      )
    }

    // Errors are re-framed for FIRST CONNECTION.
    //
    // The shared mapper turns an auth failure into TokenExpired, which is right
    // when a stored credential stops working and wrong here: telling someone
    // their connection "has expired" while they are creating it sends them
    // looking for a problem that does not exist. Same failure, different
    // moment, different message.
    const session = await this.call<{
      accessJwt: string
      refreshJwt: string
      did: string
      handle: string
    }>('com.atproto.server.createSession', {
      method: 'POST',
      body: { identifier, password },
    }).catch((error: unknown) => {
      if (error instanceof ProviderError && error.requiresReauth) {
        throw new ProviderError(
          'bluesky',
          'PermanentFailure',
          'Bluesky did not accept that handle and app password. Check the handle is spelled ' +
            'exactly as it appears on your profile, and that the password is an APP password ' +
            'created in Settings rather than your account password.'
        )
      }
      throw error
    })

    const profile = await this.call<{ displayName?: string; avatar?: string }>(
      `app.bsky.actor.getProfile?actor=${encodeURIComponent(session.did)}`,
      { method: 'GET', token: session.accessJwt }
    ).catch(() => ({ displayName: undefined, avatar: undefined }))

    return [
      {
        providerAccountId: session.did,
        handle: `@${session.handle}`,
        displayName: profile.displayName ?? session.handle,
        ...(profile.avatar ? { avatarUrl: profile.avatar } : {}),
        platformMeta: { did: session.did, serviceUrl: this.serviceUrl },
        credential: {
          accessToken: session.accessJwt,
          refreshToken: session.refreshJwt,
          scopes: ['repo.write'],
        },
      },
    ]
  }

  async refreshToken(credential: Credential): Promise<TokenSet> {
    if (!credential.refreshToken) {
      throw new ProviderError(
        'bluesky',
        'TokenExpired',
        'The connection to Bluesky has expired and cannot be renewed. Reconnect the account.'
      )
    }

    const session = await this.call<{ accessJwt: string; refreshJwt: string }>(
      'com.atproto.server.refreshSession',
      { method: 'POST', token: credential.refreshToken }
    )

    return {
      accessToken: session.accessJwt,
      // The refresh token ROTATES on every use. Persisting the new one in the
      // same transaction is mandatory — losing it locks the account out
      // permanently, with no way back except a fresh app password.
      refreshToken: session.refreshJwt,
      scopes: credential.scopes,
    }
  }

  async fetchProfile(
    account: Account,
    credential: Credential
  ): Promise<{ handle: string; displayName: string }> {
    const profile = await this.call<{ handle: string; displayName?: string }>(
      `app.bsky.actor.getProfile?actor=${encodeURIComponent(account.providerAccountId)}`,
      { method: 'GET', token: credential.accessToken }
    )
    return { handle: `@${profile.handle}`, displayName: profile.displayName ?? profile.handle }
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
    const did = String(account.platformMeta['did'] ?? account.providerAccountId)

    const embed = payload.media.length > 0
      ? await this.uploadImages(credential, payload)
      : undefined

    const record = {
      $type: 'app.bsky.feed.post',
      text: payload.text,
      createdAt: new Date().toISOString(),
      // Without facets, a URL in the text is plain characters. Bluesky does not
      // parse them server-side, so this is what makes links actually work.
      facets: detectFacets(payload.text),
      ...(embed ? { embed } : {}),
    }

    const result = await this.call<{ uri: string; cid: string }>('com.atproto.repo.createRecord', {
      method: 'POST',
      token: credential.accessToken,
      body: { repo: did, collection: 'app.bsky.feed.post', record },
    })

    return {
      remoteId: result.uri,
      remoteUrl: this.webUrlFor(account.handle, result.uri),
      providerRequestId: result.cid,
    }
  }

  async retrievePosts(account: Account, credential: Credential, since: Date): Promise<RemotePost[]> {
    const did = String(account.platformMeta['did'] ?? account.providerAccountId)

    const result = await this.call<{
      records: Array<{ uri: string; value: { text: string; createdAt: string; embed?: unknown } }>
    }>(
      `com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}` +
        `&collection=app.bsky.feed.post&limit=50`,
      { method: 'GET', token: credential.accessToken }
    )

    return result.records
      .map((r) => ({
        remoteId: r.uri,
        createdAt: new Date(r.value.createdAt),
        text: r.value.text,
        mediaCount: countEmbedImages(r.value.embed),
      }))
      .filter((r) => r.createdAt >= since)
  }

  async deletePost(account: Account, credential: Credential, remoteId: string): Promise<void> {
    const did = String(account.platformMeta['did'] ?? account.providerAccountId)
    await this.call('com.atproto.repo.deleteRecord', {
      method: 'POST',
      token: credential.accessToken,
      body: { repo: did, collection: 'app.bsky.feed.post', rkey: rkeyOf(remoteId) },
    })
  }

  async fetchPostMetrics(
    _account: Account,
    credential: Credential,
    remoteId: string
  ): Promise<RawMetrics> {
    const result = await this.call<{
      posts: Array<{ likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }>
    }>(`app.bsky.feed.getPosts?uris=${encodeURIComponent(remoteId)}`, {
      method: 'GET',
      token: credential.accessToken,
    })

    const post = result.posts[0]
    return {
      likes: post?.likeCount ?? null,
      shares: post?.repostCount ?? null,
      comments: post?.replyCount ?? null,
      // NULL, not zero. Bluesky has no insights API — it does not report these
      // at all, and a zero would be a measurement nobody took.
      impressions: null,
      reach: null,
      clicks: null,
      saves: null,
    }
  }

  async fetchComments(account: Account, credential: Credential, remoteId: string): Promise<unknown[]> {
    const result = await this.call<{ thread: { replies?: unknown[] } }>(
      `app.bsky.feed.getPostThread?uri=${encodeURIComponent(remoteId)}&depth=1`,
      { method: 'GET', token: credential.accessToken }
    )
    return result.thread.replies ?? []
  }

  async replyToComment(
    account: Account,
    credential: Credential,
    remoteId: string,
    body: string
  ): Promise<unknown> {
    // A reply is an ordinary post carrying a reply ref — the same mechanism a
    // thread uses, which is why `thread` and `replies` are one capability here.
    const did = String(account.platformMeta['did'] ?? account.providerAccountId)
    return this.call('com.atproto.repo.createRecord', {
      method: 'POST',
      token: credential.accessToken,
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: body,
          createdAt: new Date().toISOString(),
          facets: detectFacets(body),
          reply: { root: { uri: remoteId }, parent: { uri: remoteId } },
        },
      },
    })
  }

  async fetchAccountMetrics(account: Account, credential: Credential): Promise<RawMetrics> {
    const profile = await this.call<{
      followersCount?: number
      followsCount?: number
      postsCount?: number
    }>(`app.bsky.actor.getProfile?actor=${encodeURIComponent(account.providerAccountId)}`, {
      method: 'GET',
      token: credential.accessToken,
    })
    return {
      followers: profile.followersCount ?? null,
      following: profile.followsCount ?? null,
      postCount: profile.postsCount ?? null,
    }
  }

  // -------------------------------------------------------------------------

  private async uploadImages(credential: Credential, payload: PublishPayload) {
    const images: Array<{ alt: string; image: unknown }> = []

    for (const item of payload.media.slice(0, 4)) {
      const response = await fetch(item.url)
      if (!response.ok) {
        throw new ProviderError(
          'bluesky',
          'InvalidMedia',
          'Bluesky could not be given the attached media because it could not be read.'
        )
      }
      const bytes = Buffer.from(await response.arrayBuffer())

      const blob = await this.call<{ blob: unknown }>('com.atproto.repo.uploadBlob', {
        method: 'POST',
        token: credential.accessToken,
        raw: bytes,
        contentType: item.mime,
      })

      images.push({ alt: item.altText ?? '', image: blob.blob })
    }

    return { $type: 'app.bsky.embed.images', images }
  }

  private webUrlFor(handle: string, uri: string): string {
    return `https://bsky.app/profile/${handle.replace(/^@/, '')}/post/${rkeyOf(uri)}`
  }

  private async call<T>(
    path: string,
    options: {
      method: 'GET' | 'POST'
      token?: string
      body?: unknown
      raw?: Buffer
      contentType?: string
    }
  ): Promise<T> {
    // A provider call inside a database transaction would pin a Postgres
    // connection for the whole round trip.
    assertOutsideTransaction('Bluesky API request')

    const response = await fetch(`${this.serviceUrl}/xrpc/${path}`, {
      method: options.method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        'content-type': options.contentType ?? 'application/json',
      },
      ...(options.raw
        ? { body: new Uint8Array(options.raw) }
        : options.body
          ? { body: JSON.stringify(options.body) }
          : {}),
    })

    if (!response.ok) {
      throw toProviderError(response.status, await response.text().catch(() => ''))
    }

    return (await response.json()) as T
  }
}

/**
 * Maps an AT Protocol error onto the shared taxonomy.
 *
 * The retry policy reads the taxonomy, never the provider — so this is the only
 * place Bluesky's particular error shapes matter.
 */
export function toProviderError(status: number, body: string): ProviderError {
  let error = ''
  let message = ''
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string }
    error = parsed.error ?? ''
    message = parsed.message ?? ''
  } catch {
    message = body.slice(0, 200)
  }

  const code: ProviderErrorCode =
    status === 429
      ? 'RateLimited'
      : status === 401 || error === 'ExpiredToken' || error === 'InvalidToken'
        ? 'TokenExpired'
        : status === 403
          ? 'PermissionRevoked'
          : status >= 500
            ? 'ProviderDown'
            : error === 'BlobTooLarge' || error === 'InvalidMimeType'
              ? 'InvalidMedia'
              : 'ContentRejected'

  const human: Record<ProviderErrorCode, string> = {
    RateLimited: 'Bluesky is rate limiting this account. The post will be retried automatically.',
    TokenExpired: 'The Bluesky connection has expired. Reconnect the account to keep publishing.',
    PermissionRevoked: 'Bluesky refused this action for the connected account. Reconnect it.',
    InvalidMedia: `Bluesky rejected the attached media${message ? `: ${message}` : '.'}`,
    ContentRejected: `Bluesky rejected this post${message ? `: ${message}` : '.'}`,
    ProviderDown: 'Bluesky is not responding. The post will be retried automatically.',
    PermanentFailure: message || 'Bluesky refused this post and retrying will not help.',
  }

  return new ProviderError('bluesky', code, human[code], { httpStatus: status, raw: body })
}

/** The record key is the last path segment of an at:// URI. */
function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? uri
}

function countEmbedImages(embed: unknown): number {
  if (!embed || typeof embed !== 'object') return 0
  const images = (embed as { images?: unknown[] }).images
  return Array.isArray(images) ? images.length : 0
}
