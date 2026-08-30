import type {
  Account,
  Credential,
  WebhookVerification,
} from '../base.js'
import { NotImplementedYet, ProviderSkeleton } from '../skeleton.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * WhatsApp Business — documented, not implemented.
 *
 * Visible in the connect UI and DISABLED, with the reason shown. Never hidden,
 * never pretending to work. Every inherited method throws NotImplementedYet, so
 * a skeleton that accidentally gets wired up fails loudly at the first call
 * rather than silently doing nothing — which would look like a successful
 * publish.
 */
export class WhatsAppProvider extends ProviderSkeleton {
  readonly id = 'whatsapp' as const
  readonly label = 'WhatsApp Business'
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly blockedReason =
    'Requires a WhatsApp Business Account, a verified business, and approved message templates. Outbound messages outside a 24-hour window must use a pre-approved template.'

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

  sendMessage(_a: Account, _c: Credential, _conversationId: string, _body: string): Promise<unknown> {
    throw new NotImplementedYet(this.id, 'sendMessage', this.blockedReason)
  }

  replyToComment(_a: Account, _c: Credential, _remoteId: string, _body: string): Promise<unknown> {
    throw new NotImplementedYet(this.id, 'replyToComment', this.blockedReason)
  }

  verifyWebhook(_raw: Buffer, _headers: Record<string, string | undefined>): WebhookVerification {
    throw new NotImplementedYet(this.id, 'verifyWebhook', this.blockedReason)
  }
}
