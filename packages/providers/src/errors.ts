import type { ProviderId } from './capabilities/index.js'

/**
 * The shared error taxonomy.
 *
 * THE RETRY POLICY READS THE TAXONOMY, NEVER THE PROVIDER. That is the point of
 * normalising: twenty-four adapters, one set of rules about what is worth
 * retrying, so a new connector cannot invent its own retry semantics by accident.
 *
 * Every error carries a message written for a person. Provider error bodies are
 * frequently unstructured prose, so the mapper extracts what it can and falls
 * back to a written explanation of the code — never to the raw body, which
 * sometimes contains tokens.
 */

export const ERROR_CODES = [
  'RateLimited',
  'TokenExpired',
  'PermissionRevoked',
  'InvalidMedia',
  'ContentRejected',
  'ProviderDown',
  'PermanentFailure',
] as const

export type ProviderErrorCode = (typeof ERROR_CODES)[number]

/** Which codes are worth trying again. Consulted instead of per-provider logic. */
export const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'RateLimited',
  'ProviderDown',
])

/**
 * Codes meaning the connection itself is broken.
 *
 * These must NOT burn retries. The account moves to NEEDS_REAUTH and the user is
 * notified, because no amount of waiting will fix a revoked token.
 */
export const NEEDS_REAUTH: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'TokenExpired',
  'PermissionRevoked',
])

export class ProviderError extends Error {
  override readonly name = 'ProviderError'

  constructor(
    readonly provider: ProviderId,
    readonly code: ProviderErrorCode,
    message: string,
    readonly options: {
      /** Honoured over our own backoff curve when the provider supplies it. */
      retryAfterSeconds?: number
      httpStatus?: number
      providerRequestId?: string
      /** Kept for logs. Never serialised to a client. */
      raw?: unknown
    } = {}
  ) {
    super(message)
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }

  get requiresReauth(): boolean {
    return NEEDS_REAUTH.has(this.code)
  }
}

/**
 * Fallback text when a provider gives us nothing usable.
 *
 * "API Error 400" is never acceptable — a scheduling tool must be able to say
 * WHY a post will not publish, or the user cannot fix it.
 */
export function defaultMessage(code: ProviderErrorCode, label: string): string {
  switch (code) {
    case 'RateLimited':
      return `${label} is rate limiting us. This post will be retried automatically.`
    case 'TokenExpired':
      return `The connection to ${label} has expired. Reconnect the account to keep publishing.`
    case 'PermissionRevoked':
      return `${label} revoked a permission this account needs. Reconnect it to restore access.`
    case 'InvalidMedia':
      return `${label} rejected the attached media.`
    case 'ContentRejected':
      return `${label} rejected this post's content.`
    case 'ProviderDown':
      return `${label} is not responding. This post will be retried automatically.`
    case 'PermanentFailure':
      return `${label} refused this post and retrying will not help.`
  }
}
