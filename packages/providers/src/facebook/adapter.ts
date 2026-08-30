import type {
  Account,
  Credential,
  PublishPayload,
  PublishResult,
  RawMetrics,
  RemotePost,
  WebhookVerification,
} from '../base.js'
import { NotImplementedYet, ProviderSkeleton } from '../skeleton.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Facebook Pages — documented, not implemented.
 *
 * Visible in the connect UI and DISABLED, with the reason shown. Never hidden,
 * never pretending to work. Every inherited method throws NotImplementedYet, so
 * a skeleton that accidentally gets wired up fails loudly at the first call
 * rather than silently doing nothing — which would look like a successful
 * publish.
 */
export class FacebookProvider extends ProviderSkeleton {
  readonly id = 'facebook' as const
  readonly label = 'Facebook Pages'
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly blockedReason =
    'Requires a Meta app with pages_manage_posts, and App Review before it can post to Pages you do not own.'

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

  fetchAudience(_a: Account, _c: Credential): Promise<Record<string, unknown>> {
    throw new NotImplementedYet(this.id, 'fetchAudience', this.blockedReason)
  }

  fetchComments(_a: Account, _c: Credential, _remoteId: string): Promise<unknown[]> {
    throw new NotImplementedYet(this.id, 'fetchComments', this.blockedReason)
  }

  deletePost(_a: Account, _c: Credential, _remoteId: string): Promise<void> {
    throw new NotImplementedYet(this.id, 'deletePost', this.blockedReason)
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

  verifyWebhook(_raw: Buffer, _headers: Record<string, string | undefined>): WebhookVerification {
    throw new NotImplementedYet(this.id, 'verifyWebhook', this.blockedReason)
  }
}
