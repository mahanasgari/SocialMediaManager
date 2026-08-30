import { MissingTenantScope, TenantScopeMismatch } from '@smm/database'
import { TransactionBoundaryViolation } from '@smm/config'
import { NotImplementedYet, ProviderError } from '@smm/providers'

/**
 * The error envelope and its HTTP mapping.
 *
 * Two rules shape this file, both from API.md:
 *
 *   1. `message` is written for a person. "API Error 400" is never acceptable —
 *      the whole point of the provider error taxonomy is that a scheduling tool
 *      must be able to say WHY a post will not publish.
 *
 *   2. "Not found" and "not in your workspace" are never distinguished. A 403
 *      on a resource belonging to another tenant confirms that the resource
 *      exists, which is an enumeration oracle. 403 is reserved for resources the
 *      caller can legitimately see but may not act on.
 */

export type ErrorEnvelope = {
  error: {
    code: string
    message: string
    field?: string
    requestId: string
    details?: Record<string, unknown>
  }
}

export type AppErrorInit = {
  status: number
  code: string
  message: string
  field?: string
  details?: Record<string, unknown>
  /** Logged, never serialised to the client. */
  internal?: unknown
}

export class AppError extends Error {
  override readonly name = 'AppError'
  readonly status: number
  readonly code: string
  readonly field?: string
  readonly details?: Record<string, unknown>
  readonly internal?: unknown

  constructor(init: AppErrorInit) {
    super(init.message)
    this.status = init.status
    this.code = init.code
    if (init.field !== undefined) this.field = init.field
    if (init.details !== undefined) this.details = init.details
    if (init.internal !== undefined) this.internal = init.internal
  }
}

// --- Constructors for the cases the API actually produces -------------------

export const errors = {
  validation: (message: string, field?: string, details?: Record<string, unknown>) =>
    new AppError({ status: 400, code: 'validation_failed', message, ...(field ? { field } : {}), ...(details ? { details } : {}) }),

  unauthenticated: (message = 'Sign in to continue.') =>
    new AppError({ status: 401, code: 'unauthenticated', message }),

  /**
   * A request presenting both a session cookie and an API key. Rejected rather
   * than resolved by precedence: letting an attacker who can set either
   * credential choose which authority applies is a confused deputy, and it is
   * how public-API-plus-web-app products usually get owned.
   */
  authModeConflict: () =>
    new AppError({
      status: 401,
      code: 'auth_mode_conflict',
      message:
        'This request carried both a session cookie and an API key. Send one or the other, ' +
        'never both — which credential applies must never be ambiguous.',
    }),

  forbidden: (message: string, details?: Record<string, unknown>) =>
    new AppError({ status: 403, code: 'forbidden', message, ...(details ? { details } : {}) }),

  /**
   * Used BOTH for genuinely absent resources and for resources belonging to
   * another tenant. The caller cannot tell the difference, which is the point.
   */
  notFound: (what = 'resource') =>
    new AppError({
      status: 404,
      code: 'not_found',
      message: `That ${what} does not exist, or you do not have access to it.`,
    }),

  conflict: (code: string, message: string) => new AppError({ status: 409, code, message }),

  idempotencyKeyReuse: () =>
    new AppError({
      status: 409,
      code: 'idempotency_key_reuse',
      message:
        'This idempotency key was already used with a different request body. ' +
        'Use a new key, or resend the original request unchanged.',
    }),

  unprocessable: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError({ status: 422, code, message, ...(details ? { details } : {}) }),

  capabilityUnsupported: (provider: string, capability: string) =>
    new AppError({
      status: 422,
      code: 'capability_unsupported',
      message: `${provider} does not support ${capability}.`,
      details: { provider, capability },
    }),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError({
      status: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      details: { retryAfterSeconds },
    }),

  /**
   * A 429 carrying the PROVIDER's own explanation rather than a generic one.
   *
   * Separate from rateLimited because the two have different causes and
   * different fixes: ours means the caller is going too fast, theirs means the
   * connected account is — and telling someone to slow down their API calls
   * when the real limit is on their Telegram bot sends them to the wrong place.
   */
  providerRateLimited: (message: string) =>
    new AppError({ status: 429, code: 'provider_rate_limited', message }),

  dependencyUnavailable: (dependency: string) =>
    new AppError({
      status: 503,
      code: 'dependency_unavailable',
      message: `A required service (${dependency}) is unavailable. This is usually temporary.`,
      details: { dependency },
    }),

  internal: (internal?: unknown) =>
    new AppError({
      status: 500,
      code: 'internal_error',
      message: 'Something went wrong on our side. The request ID below identifies this failure.',
      ...(internal !== undefined ? { internal } : {}),
    }),
}

/**
 * Normalises any thrown value into an AppError.
 *
 * The tenancy errors are deliberately mapped to a generic 500. They mean a
 * developer forgot a scope — a bug, not something the caller did wrong — and
 * their messages name internal helpers. Echoing that back would be both
 * confusing and a small information leak.
 */
export function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err

  // A provider failure carries the only text that says WHY, written for a
  // person. Flattening it into "something went wrong on our side" throws that
  // away and blames us for a decision the platform made — the user is then told
  // to contact support about a token they could have reconnected themselves.
  if (err instanceof ProviderError) {
    switch (err.code) {
      case 'RateLimited':
        return new AppError({ status: 429, code: 'provider_rate_limited', message: err.message })
      case 'TokenExpired':
      case 'PermissionRevoked':
        // 409, not 401: the CALLER is authenticated. It is the connected
        // account that no longer is, and the fix is to reconnect it.
        return new AppError({ status: 409, code: 'account_reauth_required', message: err.message, details: { provider: err.provider } })
      case 'InvalidMedia':
      case 'ContentRejected':
        return new AppError({ status: 422, code: 'content_rejected', message: err.message, details: { provider: err.provider } })
      case 'ProviderDown':
        return new AppError({ status: 503, code: 'provider_unavailable', message: err.message })
      case 'PermanentFailure':
        return new AppError({ status: 422, code: 'provider_refused', message: err.message, details: { provider: err.provider } })
    }
  }

  // An unimplemented connector reached at runtime. 422 with the documented
  // reason, never a 500 — nothing is broken; it was never built.
  if (err instanceof NotImplementedYet) {
    return new AppError({ status: 422, code: 'provider_not_implemented', message: err.message })
  }

  if (
    err instanceof MissingTenantScope ||
    err instanceof TenantScopeMismatch ||
    err instanceof TransactionBoundaryViolation
  ) {
    return errors.internal(err)
  }

  return errors.internal(err)
}

export function toEnvelope(err: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.field ? { field: err.field } : {}),
      requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  }
}
