import type {
  Account,
  Credential,
  RawMetrics,
} from '../base.js'
import { NotImplementedYet, ProviderSkeleton } from '../skeleton.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Snapchat — documented, not implemented.
 *
 * Visible in the connect UI and DISABLED, with the reason shown. Never hidden,
 * never pretending to work. Every inherited method throws NotImplementedYet, so
 * a skeleton that accidentally gets wired up fails loudly at the first call
 * rather than silently doing nothing — which would look like a successful
 * publish.
 */
export class SnapchatProvider extends ProviderSkeleton {
  readonly id = 'snapchat' as const
  readonly label = 'Snapchat'
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly blockedReason =
    'Content publishing is restricted to approved marketing partners. There is no self-serve path.'

  // Declared capabilities, unimplemented.
  //
  // Present rather than absent so the bidirectional contract test holds for
  // skeletons too: a capability declared true must have a method, or the matrix
  // is describing a product that does not exist. Each throws, so a skeleton
  // that somehow gets invoked fails loudly instead of silently doing nothing —
  // which would look like a successful publish.
  //
  // This list is also the implementation checklist: filling these in, plus the
  // inherited auth and publish methods, is what turns this into a connector.

  fetchPostMetrics(_a: Account, _c: Credential, _remoteId: string): Promise<RawMetrics> {
    throw new NotImplementedYet(this.id, 'fetchPostMetrics', this.blockedReason)
  }

  revokeToken(_c: Credential): Promise<void> {
    throw new NotImplementedYet(this.id, 'revokeToken', this.blockedReason)
  }
}
