import type {
  CapabilityKey,
  MediaProfiles,
  ProviderCapabilities,
  ProviderId,
  ProviderState,
  Surface,
  TextProfiles,
  ValidationIssue,
  VariantDraft,
} from './capabilities/index.js'
import type { ProviderLimits } from './limits.js'

/**
 * The adapter contract every social network implements.
 *
 * Adding provider number twenty-four is one directory and one registry line.
 * If it ever requires touching the composer, the calendar, the publisher or the
 * inbox, the abstraction has leaked and THAT is the bug to fix.
 */

export type Account = {
  id: string
  providerAccountId: string
  handle: string
  displayName: string
  /** Irreducibly provider-specific: Mastodon instance URL, IG business id, … */
  platformMeta: Record<string, unknown>
}

export type Credential = {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt?: Date | undefined
  scopes: readonly string[]
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt?: Date | undefined
  scopes?: readonly string[] | undefined
}

export type DiscoveredAccount = {
  providerAccountId: string
  handle: string
  displayName: string
  avatarUrl?: string
  platformMeta?: Record<string, unknown>
  credential: Credential
}

export type PublishPayload = {
  surface: Surface
  text: string
  media: ReadonlyArray<{ url: string; mime: string; altText?: string }>
  title?: string
  /** Validated by a per-provider zod schema before it reaches the adapter. */
  platformOptions?: Record<string, unknown>
  idempotencyKey: string
}

export type PublishResult = {
  remoteId: string
  remoteUrl?: string
  /** Some providers return a container id that can still fail during processing. */
  pending?: boolean
  providerRequestId?: string
}

export type RemotePost = {
  remoteId: string
  createdAt: Date
  /** Normalised for fingerprint comparison, not for display. */
  text: string
  mediaCount: number
}

export type RawMetrics = Record<string, number | null>

export type AuthContext = {
  redirectUri: string
  state: string
  codeVerifier?: string
  /** Mastodon registers a client per instance, so config can be per-connection. */
  instanceUrl?: string
}

export type AuthRedirect = {
  url: string
  state: string
  codeVerifier?: string
}

/**
 * How an account is connected.
 *
 * `oauth`      — redirect to the provider, come back with a code.
 * `credentials`— the operator pastes a secret we can use directly: a Bluesky
 *                app password, a Telegram bot token, a WordPress application
 *                password.
 *
 * Not a cosmetic distinction. A `credentials` provider has no URL to redirect
 * to, so a UI that only knows how to start an OAuth flow simply cannot connect
 * it — which is how a fully implemented connector ends up unreachable behind a
 * button that does nothing.
 */
export type AuthStyle = 'oauth' | 'credentials'

/**
 * One value collected from the operator before a connection can start.
 *
 * For a `credentials` provider these ARE the credential — a Bluesky app
 * password, a Telegram bot token. For an `oauth` provider they are parameters
 * the authorize URL cannot be built without: Mastodon registers its app per
 * instance, so there is no URL to redirect to until someone has named one.
 *
 * Same shape either way, because the form that collects them is the same form.
 */
export type CredentialField = {
  name: string
  label: string
  /** `password` is masked in the UI and never echoed back. */
  type: 'text' | 'password'
  /** Shown under the field. Say where to GET the value, not what it is. */
  hint?: string
  placeholder?: string
}

/** Base surface every adapter implements. */
export interface BaseProvider {
  readonly id: ProviderId
  readonly label: string
  readonly state: ProviderState
  readonly capabilities: ProviderCapabilities
  readonly limits: ProviderLimits
  readonly media: MediaProfiles
  readonly text: TextProfiles

  /** True when the operator supplied credentials for this provider. */
  isConfigured(): boolean

  /** Defaults to 'oauth' when a provider does not say otherwise. */
  readonly authStyle?: AuthStyle

  /**
   * Values to collect before connecting. Rendered as the connect form.
   *
   * Required when authStyle is 'credentials'. Optional for 'oauth', where a
   * non-empty list means the authorize URL cannot be built until they are
   * supplied.
   */
  readonly connectFields?: readonly CredentialField[]

  getAuthUrl(ctx: AuthContext): Promise<AuthRedirect>
  handleCallback(ctx: AuthContext, params: Record<string, string>): Promise<DiscoveredAccount[]>
  refreshToken(credential: Credential): Promise<TokenSet>
  fetchProfile(account: Account, credential: Credential): Promise<{ handle: string; displayName: string }>

  /** PURE. No I/O. Shared verbatim with the browser. */
  validate(draft: VariantDraft): ValidationIssue[]

  publish(account: Account, credential: Credential, payload: PublishPayload): Promise<PublishResult>
}

/** Methods gated behind a capability of the same name. */
export type CapabilityMethods = {
  retrievePosts: {
    retrievePosts(account: Account, credential: Credential, since: Date): Promise<RemotePost[]>
  }
  deletePost: { deletePost(account: Account, credential: Credential, remoteId: string): Promise<void> }
  editPost: {
    editPost(
      account: Account,
      credential: Credential,
      remoteId: string,
      payload: PublishPayload
    ): Promise<PublishResult>
  }
  revokeToken: { revokeToken(credential: Credential): Promise<void> }
  comments: {
    fetchComments(account: Account, credential: Credential, remoteId: string): Promise<unknown[]>
  }
  replies: {
    replyToComment(
      account: Account,
      credential: Credential,
      remoteId: string,
      body: string
    ): Promise<unknown>
  }
  dm: {
    sendMessage(
      account: Account,
      credential: Credential,
      conversationId: string,
      body: string
    ): Promise<unknown>
  }
  analytics: {
    fetchPostMetrics(account: Account, credential: Credential, remoteId: string): Promise<RawMetrics>
  }
  audienceAnalytics: {
    fetchAudience(account: Account, credential: Credential): Promise<Record<string, unknown>>
  }
  webhooks: {
    /**
     * Verifies an inbound event, over the RAW BYTES as received.
     *
     * Takes a Buffer rather than a parsed object, and that signature is the
     * point: every provider computes its HMAC over the exact bytes it sent, so
     * anything that has been through JSON.parse has already lost the
     * information needed to check it. Key order, unicode escapes and number
     * formatting all survive a round trip *visually* while changing the bytes.
     *
     * Returns a reason on failure so an operator debugging a misconfigured
     * subscription is not left staring at a bare false.
     */
    verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookVerification

    /** Normalises a verified payload into inbox events. Pure. */
    parseWebhook(payload: unknown): InboundEventShape[]
  }
}

export type WebhookVerification =
  | { valid: true; providerAccountId: string | null }
  | { valid: false; reason: string }

/** A provider event, normalised to the shape the inbox stores. */
export type InboundEventShape = {
  kind: 'COMMENT_THREAD' | 'DM' | 'MENTION'
  providerAccountId: string
  providerConversationId: string
  providerMessageId: string
  authorHandle: string
  body: string
  /** From the PROVIDER, never arrival time — webhooks arrive out of order. */
  providerCreatedAt: Date
  parentProviderMessageId?: string | undefined
  mediaUrls?: string[] | undefined
}

export type AnyProvider = BaseProvider & Partial<UnionToIntersection<CapabilityMethods[keyof CapabilityMethods]>>

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never

/** Thrown when a capability the provider does not declare is invoked. */
export class UnsupportedCapability extends Error {
  override readonly name = 'UnsupportedCapability'

  constructor(
    readonly provider: ProviderId,
    readonly capability: CapabilityKey
  ) {
    super(`${provider} does not support ${capability}.`)
  }
}

/**
 * Runtime narrowing — the ACTUAL guarantee.
 *
 * Conditional types can bind methods to capabilities for the adapter *author*,
 * but they have two limits worth stating: error messages at that composition
 * depth are close to unreadable, and any code iterating the registry holds the
 * widened union, where the conditional intersections collapse. Every real call
 * site — inbox, publisher, analytics ingester — is exactly such a site.
 *
 * So the type system helps whoever writes an adapter, and this assertion is what
 * actually protects whoever calls one.
 */
export function withCapability<K extends keyof CapabilityMethods>(
  provider: AnyProvider,
  capability: K
): asserts provider is AnyProvider & CapabilityMethods[K] {
  if (!provider.capabilities[capability]) {
    throw new UnsupportedCapability(provider.id, capability)
  }
}

/** Non-throwing variant, for deciding what to render. */
export function supports(provider: AnyProvider, capability: CapabilityKey): boolean {
  return provider.capabilities[capability] === true
}
