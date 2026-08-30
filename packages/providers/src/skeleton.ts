import type { AnyProvider, AuthContext, AuthRedirect, Credential, DiscoveredAccount, PublishPayload, PublishResult, TokenSet, Account } from './base.js'
import type { ProviderLimits } from './limits.js'
import {
  validateMedia,
  validateText,
  type MediaProfiles,
  type ProviderCapabilities,
  type ProviderId,
  type TextProfiles,
  type ValidationIssue,
  type VariantDraft,
} from './capabilities/index.js'

/**
 * Base for a provider that is DOCUMENTED but not implemented.
 *
 * The honesty policy: every provider is in exactly one declared state, and a
 * skeleton is visible in the connect UI, DISABLED, with the reason shown. Never
 * hidden, never pretending to work.
 *
 * Every unimplemented method throws with a message naming what is missing, so a
 * skeleton that accidentally gets wired up fails loudly at the first call rather
 * than silently doing nothing — which would look like a successful publish.
 */
export class NotImplementedYet extends Error {
  override readonly name = 'NotImplementedYet'
  constructor(provider: ProviderId, method: string, reason: string) {
    super(`${provider}.${method}() is not implemented. ${reason}`)
  }
}

export abstract class ProviderSkeleton implements AnyProvider {
  abstract readonly id: ProviderId
  abstract readonly label: string
  abstract readonly capabilities: ProviderCapabilities
  abstract readonly limits: ProviderLimits
  abstract readonly media: MediaProfiles
  abstract readonly text: TextProfiles
  /** Shown to the operator in the connect UI. Must say WHY, specifically. */
  abstract readonly blockedReason: string

  readonly state = 'skeleton' as const

  /** A skeleton is never usable, whatever credentials the operator supplied. */
  isConfigured(): boolean {
    return false
  }

  /** Pure and real even in a skeleton — the composer can preview constraints. */
  validate(draft: VariantDraft): ValidationIssue[] {
    return [
      ...validateText(draft, this.text[draft.surface], this.label),
      ...validateMedia(draft, this.media[draft.surface], this.label),
    ]
  }

  getAuthUrl(_ctx: AuthContext): Promise<AuthRedirect> {
    throw new NotImplementedYet(this.id, 'getAuthUrl', this.blockedReason)
  }
  handleCallback(_ctx: AuthContext, _p: Record<string, string>): Promise<DiscoveredAccount[]> {
    throw new NotImplementedYet(this.id, 'handleCallback', this.blockedReason)
  }
  refreshToken(_c: Credential): Promise<TokenSet> {
    throw new NotImplementedYet(this.id, 'refreshToken', this.blockedReason)
  }
  fetchProfile(_a: Account, _c: Credential): Promise<{ handle: string; displayName: string }> {
    throw new NotImplementedYet(this.id, 'fetchProfile', this.blockedReason)
  }
  publish(_a: Account, _c: Credential, _p: PublishPayload): Promise<PublishResult> {
    throw new NotImplementedYet(this.id, 'publish', this.blockedReason)
  }
}
