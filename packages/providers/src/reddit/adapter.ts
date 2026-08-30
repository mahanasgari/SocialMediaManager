import type {
  Account,
  Credential,
  PublishPayload,
  PublishResult,
  RawMetrics,
  RemotePost,
} from '../base.js'
import { NotImplementedYet, ProviderSkeleton } from '../skeleton.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Reddit — documented, not implemented.
 *
 * Visible in the connect UI and DISABLED, with the reason shown. Never hidden,
 * never pretending to work. Every inherited method throws NotImplementedYet, so
 * a skeleton that accidentally gets wired up fails loudly at the first call
 * rather than silently doing nothing — which would look like a successful
 * publish.
 */
export class RedditProvider extends ProviderSkeleton {
  readonly id = 'reddit' as const
  readonly label = 'Reddit'
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly blockedReason =
    'Requires a Reddit app and agreement to the Data API terms. Verify current commercial terms before enabling.'

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

  fetchComments(_a: Account, _c: Credential, _remoteId: string): Promise<unknown[]> {
    throw new NotImplementedYet(this.id, 'fetchComments', this.blockedReason)
  }

  deletePost(_a: Account, _c: Credential, _remoteId: string): Promise<void> {
    throw new NotImplementedYet(this.id, 'deletePost', this.blockedReason)
  }

  sendMessage(_a: Account, _c: Credential, _conversationId: string, _body: string): Promise<unknown> {
    throw new NotImplementedYet(this.id, 'sendMessage', this.blockedReason)
  }

  editPost(_a: Account, _c: Credential, _remoteId: string, _p: PublishPayload): Promise<PublishResult> {
    throw new NotImplementedYet(this.id, 'editPost', this.blockedReason)
  }

  replyToComment(_a: Account, _c: Credential, _remoteId: string, _body: string): Promise<unknown> {
    throw new NotImplementedYet(this.id, 'replyToComment', this.blockedReason)
  }

  retrievePosts(_a: Account, _c: Credential, _since: Date): Promise<RemotePost[]> {
    throw new NotImplementedYet(this.id, 'retrievePosts', this.blockedReason)
  }

  revokeToken(_c: Credential): Promise<void> {
    throw new NotImplementedYet(this.id, 'revokeToken', this.blockedReason)
  }
}
