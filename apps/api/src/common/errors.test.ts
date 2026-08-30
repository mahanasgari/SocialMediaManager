import { describe, expect, it } from 'vitest'
import { MissingTenantScope, TenantScopeMismatch } from '@smm/database'
import { TransactionBoundaryViolation } from '@smm/config'
import { AppError, errors, normalize, toEnvelope } from './errors.js'

const RID = '01J8Z9ABCDEF'

describe('error envelope shape', () => {
  it('always carries a request id so a user can quote one thing', () => {
    const envelope = toEnvelope(errors.notFound('post'), RID)
    expect(envelope.error.requestId).toBe(RID)
  })

  it('omits optional fields rather than emitting nulls', () => {
    const envelope = toEnvelope(errors.unauthenticated(), RID)
    expect(envelope.error).not.toHaveProperty('field')
    expect(envelope.error).not.toHaveProperty('details')
  })

  it('includes field and details when present', () => {
    const envelope = toEnvelope(
      errors.validation('Aspect ratio is out of range.', 'media[0]', { actual: 3.0 }),
      RID
    )
    expect(envelope.error.field).toBe('media[0]')
    expect(envelope.error.details).toEqual({ actual: 3.0 })
  })
})

describe('messages are written for people', () => {
  const cases: AppError[] = [
    errors.validation('Aspect ratio is out of range.', 'media[0]'),
    errors.unauthenticated(),
    errors.authModeConflict(),
    errors.forbidden('Only an editor can publish.'),
    errors.notFound('post'),
    errors.idempotencyKeyReuse(),
    errors.capabilityUnsupported('Bluesky', 'direct messages'),
    errors.rateLimited(30),
    errors.dependencyUnavailable('Redis'),
    errors.internal(),
  ]

  it.each(cases.map((e) => [e.code, e] as const))(
    '%s reads as a sentence, not a status code',
    (_code, err) => {
      expect(err.message.length).toBeGreaterThan(15)
      expect(err.message).toMatch(/[.!]$/)
      // The failure this guards against is literally "API Error 400".
      expect(err.message).not.toMatch(/^(API )?Error \d+/i)
    }
  )

  it('tells the caller what to do about a rate limit', () => {
    const err = errors.rateLimited(30)
    expect(err.message).toContain('30')
    expect(err.details).toEqual({ retryAfterSeconds: 30 })
  })

  it('names the provider and capability rather than saying "unsupported"', () => {
    const err = errors.capabilityUnsupported('Bluesky', 'direct messages')
    expect(err.message).toContain('Bluesky')
    expect(err.message).toContain('direct messages')
  })
})

describe('existence is not leaked', () => {
  it('404 does not distinguish absent from another tenant', () => {
    // A 403 here would confirm the resource exists, giving an enumeration
    // oracle. The message deliberately covers both cases at once — and is
    // phrased to read correctly even when the resource IS a workspace.
    const err = errors.notFound('post')
    expect(err.status).toBe(404)
    expect(err.message).toMatch(/does not exist, or you do not have access to it/)
  })

  it('403 is reserved for resources the caller can legitimately see', () => {
    expect(errors.forbidden('Only an editor can publish.').status).toBe(403)
  })
})

describe('dual-auth conflict', () => {
  it('is a 401 with its own code, not a generic unauthenticated', () => {
    const err = errors.authModeConflict()
    expect(err.status).toBe(401)
    expect(err.code).toBe('auth_mode_conflict')
    // The message has to explain WHY both credentials is refused, or the caller
    // will assume it is a bug and retry with both again.
    expect(err.message).toMatch(/never both/i)
  })
})

describe('normalize', () => {
  it('passes an AppError through unchanged', () => {
    const original = errors.notFound('workspace')
    expect(normalize(original)).toBe(original)
  })

  // These three mean a developer forgot something. They are bugs, not caller
  // mistakes, and their messages name internal helpers — echoing that back would
  // be confusing and mildly leaky.
  it.each([
    ['MissingTenantScope', new MissingTenantScope('Post', 'findMany')],
    ['TenantScopeMismatch', new TenantScopeMismatch('Post', 'workspace', 'organization')],
    ['TransactionBoundaryViolation', new TransactionBoundaryViolation('provider HTTP request')],
  ])('maps %s to a generic 500 without leaking internals', (_name, err) => {
    const normalized = normalize(err)
    expect(normalized.status).toBe(500)
    expect(normalized.code).toBe('internal_error')
    expect(normalized.message).not.toContain('tenant scope')
    expect(normalized.message).not.toContain('transaction')
    // The original is retained for logs, just never serialised.
    expect(normalized.internal).toBe(err)
  })

  it('never serialises the internal cause into the envelope', () => {
    const envelope = toEnvelope(normalize(new Error('connection string: postgres://u:p@h')), RID)
    expect(JSON.stringify(envelope)).not.toContain('postgres://')
  })

  it('turns an unknown throw into a 500 rather than crashing the handler', () => {
    expect(normalize('a bare string').status).toBe(500)
    expect(normalize(undefined).status).toBe(500)
  })
})

describe('status mapping', () => {
  it.each([
    [errors.validation('x.'), 400],
    [errors.unauthenticated(), 401],
    [errors.authModeConflict(), 401],
    [errors.forbidden('x.'), 403],
    [errors.notFound(), 404],
    [errors.idempotencyKeyReuse(), 409],
    [errors.capabilityUnsupported('X', 'y'), 422],
    [errors.rateLimited(1), 429],
    [errors.dependencyUnavailable('Redis'), 503],
    [errors.internal(), 500],
  ])('%#: maps to the documented status', (err, status) => {
    expect(err.status).toBe(status)
  })
})
