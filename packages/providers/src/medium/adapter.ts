import { ProviderSkeleton } from '../skeleton.js'
import { capabilities, limits, media, text } from './capabilities.js'

/**
 * Medium — documented, not implemented.
 *
 * Visible in the connect UI and DISABLED, with the reason shown. Never hidden,
 * never pretending to work. Every inherited method throws NotImplementedYet, so
 * a skeleton that accidentally gets wired up fails loudly at the first call
 * rather than silently doing nothing — which would look like a successful
 * publish.
 */
export class MediumProvider extends ProviderSkeleton {
  readonly id = 'medium' as const
  readonly label = 'Medium'
  readonly capabilities = capabilities
  readonly limits = limits
  readonly media = media
  readonly text = text
  readonly blockedReason =
    'The Medium publishing API has been retired to existing integration tokens only. ' +
    'New applications are not being accepted.'
}
