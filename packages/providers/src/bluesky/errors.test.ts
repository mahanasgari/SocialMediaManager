import { describe, expect, it } from 'vitest'
import { toProviderError } from './adapter.js'

const body = (error: string, message?: string) => JSON.stringify({ error, message })

/**
 * The retry policy reads the TAXONOMY, never the provider. These tests pin the
 * mapping, because getting one wrong means either burning retries on something
 * that will never succeed, or giving up on something that would have.
 */
describe('error mapping', () => {
  it('429 is retryable and does not flag the account', () => {
    const err = toProviderError(429, body('RateLimitExceeded'))
    expect(err.code).toBe('RateLimited')
    expect(err.retryable).toBe(true)
    // A rate limit is the provider telling us our budget was wrong, not that
    // the connection is broken.
    expect(err.requiresReauth).toBe(false)
  })

  it('401 needs reauth and must NOT be retried', () => {
    const err = toProviderError(401, body('ExpiredToken'))
    expect(err.code).toBe('TokenExpired')
    expect(err.retryable).toBe(false)
    expect(err.requiresReauth).toBe(true)
  })

  it('an ExpiredToken body maps even on a non-401 status', () => {
    // Providers are not consistent about status codes; the body is often the
    // more reliable signal.
    expect(toProviderError(400, body('ExpiredToken')).code).toBe('TokenExpired')
  })

  it('403 is a revoked permission, not a content problem', () => {
    const err = toProviderError(403, body('Forbidden'))
    expect(err.code).toBe('PermissionRevoked')
    expect(err.requiresReauth).toBe(true)
  })

  it('5xx is retryable', () => {
    const err = toProviderError(503, 'upstream unavailable')
    expect(err.code).toBe('ProviderDown')
    expect(err.retryable).toBe(true)
  })

  it('an oversized blob is a media problem, not a content one', () => {
    // The distinction matters to the person reading it: one means "shrink the
    // image", the other means "rewrite the post".
    expect(toProviderError(400, body('BlobTooLarge')).code).toBe('InvalidMedia')
    expect(toProviderError(400, body('InvalidMimeType')).code).toBe('InvalidMedia')
  })

  it('an unrecognised 4xx is a content rejection and is not retried', () => {
    const err = toProviderError(400, body('InvalidRequest', 'Record/text must not be longer'))
    expect(err.code).toBe('ContentRejected')
    expect(err.retryable).toBe(false)
  })
})

describe('messages', () => {
  it('reads as a sentence, never a status code', () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const message = toProviderError(status, body('Whatever')).message
      expect(message).toMatch(/[.!]$/)
      expect(message).not.toMatch(/^\d/)
      expect(message).toContain('Bluesky')
    }
  })

  it('tells the user to reconnect when that is the fix', () => {
    expect(toProviderError(401, body('ExpiredToken')).message).toMatch(/[Rr]econnect/)
  })

  it("says it will retry when it will, so nobody thinks the post is lost", () => {
    expect(toProviderError(429, body('x')).message).toMatch(/retried automatically/)
    expect(toProviderError(500, '').message).toMatch(/retried automatically/)
  })

  it("includes the provider's own explanation when it gives one", () => {
    const err = toProviderError(400, body('InvalidRequest', 'text must not be longer than 300'))
    expect(err.message).toContain('300')
  })

  it('survives a non-JSON body without throwing', () => {
    // Provider error bodies are frequently unstructured prose or HTML.
    const err = toProviderError(502, '<html><body>Bad Gateway</body></html>')
    expect(err.code).toBe('ProviderDown')
    expect(err.message).toBeTruthy()
  })

  it('keeps the raw body for logs but not in the message', () => {
    const err = toProviderError(400, body('InvalidRequest', 'detail here'))
    expect(err.options.raw).toContain('InvalidRequest')
    expect(err.message).not.toContain('InvalidRequest')
  })
})
