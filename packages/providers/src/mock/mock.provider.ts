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
  InboundEventShape,
  WebhookVerification,
} from '../base.js'
import { ProviderError } from '../errors.js'
import type { ProviderLimits } from '../limits.js'
import {
  MB,
  validateMedia,
  validateText,
  type MediaProfiles,
  type ProviderCapabilities,
  type TextProfiles,
  type ValidationIssue,
  type VariantDraft,
} from '../capabilities/index.js'
import { verifyHmac } from '../webhook-signature.js'
import { FileLedger } from './ledger.js'

/**
 * The provider simulator.
 *
 * This is what makes the entire product developable and CI-testable with zero
 * real credentials, and it is why it lands in Phase 2 before any real connector.
 * Every downstream phase — composer, calendar, publishing engine, inbox,
 * analytics — is built against it.
 *
 * A caveat that shapes how much it should be trusted: a mock encodes OUR
 * assumptions, and social APIs are largely a catalogue of ways those assumptions
 * are wrong. That is why real anchor connectors land at the Phase 4, 6 and 7
 * gates, each producing a divergence report, and why this file is CORRECTED by
 * those reports. It should become an artifact of evidence rather than of
 * imagination.
 */

export const MOCK_SCENARIOS = [
  'success',
  'publish_failure',
  'token_expired',
  'permission_revoked',
  'rate_limited',
  'invalid_media',
  'network_timeout',
  /**
   * Accepts the request, then never answers.
   *
   * The fault-injection scenario for reconciliation: a worker killed after the
   * IN_FLIGHT attempt commits but before the response arrives must reconcile
   * rather than republish. This is the top-ranked risk in the whole system, and
   * "duplicate job execution" does not exercise it.
   */
  'accept_then_hang',
  'partial_multi',
] as const

export type MockScenario = (typeof MOCK_SCENARIOS)[number]

export const mockCapabilities: ProviderCapabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  carousel: true,
  linkPost: true,
  thread: true,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: true,
  draftSupport: false,
  editPost: true,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  dm: true,
  conversations: true,
  reactions: true,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: true,
}

export const mockLimits: ProviderLimits = {
  publish: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 1000, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 500, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 8 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
}

const mockMedia: MediaProfiles = {
  feed: { mime: ['image/jpeg', 'image/png', 'video/mp4'], maxBytes: 8 * MB, maxCount: 4 },
  feedImage: {
    mime: ['image/jpeg', 'image/png'],
    maxBytes: 8 * MB,
    maxCount: 4,
    aspect: { min: 0.5, max: 2 },
    altTextMaxLength: 1000,
  },
}

const mockText: TextProfiles = {
  feed: { maxLength: 500, maxHashtags: null, maxMentions: null, linkHandling: 'counted' },
  feedImage: { maxLength: 500, maxHashtags: 30, maxMentions: 10, linkHandling: 'counted' },
}

export type MockOptions = {
  /** Scenario per provider-account id. Anything unlisted behaves as success. */
  scenarios?: Record<string, MockScenario>
  /** Overridden in tests so a hang does not actually take 30 seconds. */
  hangMs?: number
  /** Published posts, so retrievePosts can reconcile against them. */
  store?: Map<string, RemotePost[]>
  /**
   * A ledger that outlives this process, for fault injection.
   *
   * Set via SMM_MOCK_LEDGER. Without it the record of what was published dies
   * with the worker that published it, so a crash-recovery test would ask a
   * fresh process "did that go out?" and be told no — proving the opposite of
   * what it set out to prove.
   */
  ledgerPath?: string
  /** Simulates a provider with no read-back, where exactly-once is impossible. */
  noReadBack?: boolean
}

export class MockProvider implements AnyProvider {
  readonly id = 'mock' as const
  readonly label = 'Mock Provider'
  readonly state = 'mock' as const
  /**
   * An instance field, not the shared constant, so one seam can be opened.
   *
   * Providers WITHOUT read-back are the hard case for reconciliation: with no
   * way to ask "did that post land?", exactly-once is not achievable and the
   * only honest move is to ask a human. Every real provider that behaves this
   * way is a skeleton here, so without this the branch would be unreachable in
   * tests — and an unreachable branch on the top-ranked risk is a branch that
   * is wrong.
   */
  readonly capabilities: ProviderCapabilities
  readonly limits = mockLimits
  readonly media = mockMedia
  readonly text = mockText

  private readonly scenarios: Record<string, MockScenario>
  private readonly hangMs: number
  private readonly store: Map<string, RemotePost[]>
  private readonly ledger: FileLedger | null

  constructor(options: MockOptions = {}) {
    this.scenarios = options.scenarios ?? {}
    this.hangMs = options.hangMs ?? 30_000
    this.store = options.store ?? new Map()

    // Environment as well as options, because the fault-injection harness
    // launches a real worker process and cannot reach into its registry to
    // construct one by hand.
    this.capabilities =
      options.noReadBack ?? process.env['SMM_MOCK_NO_READBACK'] === '1'
        ? { ...mockCapabilities, retrievePosts: false }
        : mockCapabilities

    const path = options.ledgerPath ?? process.env['SMM_MOCK_LEDGER']
    this.ledger = path ? new FileLedger(path) : null
  }

  /** Always configured: it needs no operator credentials, which is the point. */
  isConfigured(): boolean {
    return true
  }

  /**
   * Scenario resolution, in order: the account's own platformMeta, then the
   * in-memory map, then success.
   *
   * Reading platformMeta is what lets DEMO MODE show real failure behaviour —
   * a seeded account can be configured to rate-limit or reject content, so
   * partial publishing is something you can see rather than read about. Tests
   * keep using the in-memory map, which needs no database.
   */
  scenarioFor(providerAccountId: string, platformMeta?: Record<string, unknown>): MockScenario {
    const fromMeta = platformMeta?.['mockScenario']
    if (typeof fromMeta === 'string' && (MOCK_SCENARIOS as readonly string[]).includes(fromMeta)) {
      return fromMeta as MockScenario
    }
    return this.scenarios[providerAccountId] ?? 'success'
  }

  setScenario(providerAccountId: string, scenario: MockScenario): void {
    this.scenarios[providerAccountId] = scenario
  }

  /**
   * Redirects straight back to our own callback.
   *
   * A mock that pointed at an unreachable host would make demo mode a dead end:
   * you could see the connect button and never complete a connection. Bouncing
   * through the real callback means the whole flow — signed state, redirect
   * allowlisting, account discovery, credential encryption — is exercised by
   * clicking the button, which is exactly what a simulator is for.
   */
  async getAuthUrl(ctx: AuthContext): Promise<AuthRedirect> {
    const url = new URL(ctx.redirectUri)
    url.searchParams.set('state', ctx.state)
    url.searchParams.set('code', 'mock-authorization-code')
    url.searchParams.set('accounts', '1')
    return { url: url.toString(), state: ctx.state }
  }

  async handleCallback(_ctx: AuthContext, params: Record<string, string>): Promise<DiscoveredAccount[]> {
    // Returns an ARRAY because one real OAuth grant commonly yields several
    // accounts — Facebook Pages, YouTube channels. Modelling it as 1:1 forces a
    // painful migration later, so the mock exercises the plural shape from day one.
    const count = Number(params['accounts'] ?? 1)
    return Array.from({ length: count }, (_, i) => ({
      providerAccountId: `mock-account-${i + 1}`,
      handle: `@mock${i + 1}`,
      displayName: `Mock Account ${i + 1}`,
      credential: { accessToken: `mock-token-${i + 1}`, scopes: ['read', 'write'] },
    }))
  }

  async refreshToken(credential: Credential): Promise<TokenSet> {
    return {
      accessToken: `${credential.accessToken}-refreshed`,
      refreshToken: credential.refreshToken,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: credential.scopes,
    }
  }

  async fetchProfile(account: Account): Promise<{ handle: string; displayName: string }> {
    return { handle: account.handle, displayName: account.displayName }
  }

  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  async publish(
    account: Account,
    _credential: Credential,
    payload: PublishPayload
  ): Promise<PublishResult> {
    const scenario = this.scenarioFor(account.providerAccountId, account.platformMeta)

    switch (scenario) {
      case 'publish_failure':
        throw new ProviderError('mock', 'ContentRejected', 'Mock Provider rejected this post.')

      case 'token_expired':
        throw new ProviderError(
          'mock',
          'TokenExpired',
          'The connection to Mock Provider has expired. Reconnect the account to keep publishing.'
        )

      case 'permission_revoked':
        throw new ProviderError(
          'mock',
          'PermissionRevoked',
          'Mock Provider revoked a permission this account needs.'
        )

      case 'rate_limited':
        throw new ProviderError('mock', 'RateLimited', 'Mock Provider is rate limiting us.', {
          retryAfterSeconds: 42,
          httpStatus: 429,
        })

      case 'invalid_media':
        throw new ProviderError(
          'mock',
          'InvalidMedia',
          'Mock Provider rejected the attached media because the aspect ratio is out of range.'
        )

      case 'network_timeout':
        throw new ProviderError('mock', 'ProviderDown', 'Mock Provider did not respond.')

      case 'accept_then_hang': {
        // Records the post FIRST, then hangs. That ordering is the whole point:
        // the post really did land, so a reconciler querying retrievePosts must
        // find it and mark PUBLISHED instead of publishing a duplicate.
        this.record(account, payload)
        await new Promise((resolve) => setTimeout(resolve, this.hangMs))
        throw new ProviderError('mock', 'ProviderDown', 'Mock Provider did not respond.')
      }

      case 'partial_multi':
      case 'success':
      default: {
        const remoteId = this.record(account, payload)
        return {
          remoteId,
          remoteUrl: `https://mock.invalid/${account.providerAccountId}/${remoteId}`,
          providerRequestId: `req-${remoteId}`,
        }
      }
    }
  }

  async retrievePosts(account: Account, _credential: Credential, since: Date): Promise<RemotePost[]> {
    const posts = [
      ...(this.store.get(account.providerAccountId) ?? []),
      ...(this.ledger?.read(account.providerAccountId) ?? []),
    ]
    return posts.filter((p) => p.createdAt >= since)
  }

  async deletePost(account: Account, _credential: Credential, remoteId: string): Promise<void> {
    const posts = this.store.get(account.providerAccountId) ?? []
    this.store.set(
      account.providerAccountId,
      posts.filter((p) => p.remoteId !== remoteId)
    )
  }

  async editPost(
    account: Account,
    credential: Credential,
    _remoteId: string,
    payload: PublishPayload
  ): Promise<PublishResult> {
    return this.publish(account, credential, payload)
  }

  async revokeToken(): Promise<void> {
    // Nothing to revoke; present because capabilities.revokeToken is true, and
    // the contract test asserts declaration and implementation agree.
  }

  async fetchComments(): Promise<unknown[]> {
    return [{ id: 'mock-comment-1', body: 'Nice post', author: '@someone' }]
  }

  async replyToComment(_a: Account, _c: Credential, _r: string, body: string): Promise<unknown> {
    return { id: `mock-reply-${Date.now()}`, body }
  }

  async sendMessage(_a: Account, _c: Credential, conversationId: string, body: string) {
    return { id: `mock-message-${Date.now()}`, conversationId, body }
  }

  async fetchPostMetrics(): Promise<RawMetrics> {
    return {
      impressions: 1200,
      reach: 900,
      likes: 42,
      comments: 7,
      shares: 3,
      // Null, not zero. The UI must render "—" for a metric a platform does not
      // report; "0 saves" would be a lie about a number nobody measured.
      saves: null,
      clicks: 18,
    }
  }

  /**
   * Verifies a simulated inbound event.
   *
   * Real HMAC over the real raw bytes, with the same shared secret mechanism a
   * real provider uses — NOT a stub returning true. A mock that waves events
   * through would validate the receiver against a fiction, and the receiver is
   * the one place where workspace context comes from untrusted input.
   *
   * MOCK_WEBHOOK_SECRET must be set for the mock to receive at all, exactly as
   * a real connector requires its secret. Demo mode sets one.
   */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const result = verifyHmac(raw, {
      secret: process.env['MOCK_WEBHOOK_SECRET'],
      signature: headers['x-mock-signature'],
      prefix: 'sha256=',
    })
    if (!result.valid) return result
    return { valid: true, providerAccountId: null }
  }

  /** Normalises the mock event shape, which mirrors a simple provider. */
  parseWebhook(payload: unknown): InboundEventShape[] {
    const event = payload as {
      account_id?: string
      conversation_id?: string
      message_id?: string
      author?: string
      body?: string
      created_at?: string
      kind?: string
      parent_id?: string
    }
    if (!event.conversation_id || !event.message_id) return []

    const kind =
      event.kind === 'DM' || event.kind === 'MENTION' ? event.kind : 'COMMENT_THREAD'

    return [
      {
        kind,
        providerAccountId: event.account_id ?? '',
        providerConversationId: event.conversation_id,
        providerMessageId: event.message_id,
        authorHandle: event.author ?? '@someone',
        body: event.body ?? '',
        // Falls back to now ONLY when the payload omits it. A provider that
        // sends no timestamp cannot be ordered correctly, and pretending
        // otherwise hides that.
        providerCreatedAt: event.created_at ? new Date(event.created_at) : new Date(),
        ...(event.parent_id ? { parentProviderMessageId: event.parent_id } : {}),
      },
    ]
  }

  private record(account: Account, payload: PublishPayload): string {
    const remoteId = `mock-post-${Math.random().toString(36).slice(2, 10)}`
    const posts = this.store.get(account.providerAccountId) ?? []
    posts.push({
      remoteId,
      createdAt: new Date(),
      text: payload.text,
      mediaCount: payload.media.length,
    })
    this.store.set(account.providerAccountId, posts)

    // Synchronously, before returning. In the accept-then-hang scenario this
    // process is about to be killed on purpose, and a buffered write would be
    // lost — which is the in-memory problem again, reached more slowly.
    this.ledger?.append(account.providerAccountId, posts[posts.length - 1]!)

    return remoteId
  }
}
