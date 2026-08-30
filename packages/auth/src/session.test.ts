import { describe, expect, it } from 'vitest'
import {
  hashApiKey,
  hashSessionToken,
  issueApiKey,
  issueSessionToken,
  looksLikeApiKey,
  resolveAuthMode,
  tokensMatch,
} from './session.js'
import { hashPassword, needsRehash, verifyPassword } from './password.js'

describe('session tokens', () => {
  it('issues a token whose plaintext is not recoverable from the stored hash', () => {
    const { token, hash } = issueSessionToken()
    expect(hash).not.toContain(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => issueSessionToken().token))
    expect(seen.size).toBe(500)
  })

  it('hashes deterministically so a presented token can be looked up', () => {
    const { token, hash } = issueSessionToken()
    expect(hashSessionToken(token)).toBe(hash)
  })

  it('carries at least 256 bits of entropy', () => {
    // base64url of 32 bytes is 43 characters. Shorter would mean the CSPRNG call
    // was changed without the security note being revisited.
    expect(issueSessionToken().token.length).toBeGreaterThanOrEqual(43)
  })
})

describe('tokensMatch', () => {
  it('matches identical values and rejects differing ones', () => {
    const { hash } = issueSessionToken()
    expect(tokensMatch(hash, hash)).toBe(true)
    expect(tokensMatch(hash, issueSessionToken().hash)).toBe(false)
  })

  it('returns false on a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; the early return keeps a
    // malformed cookie from becoming a 500 that tells an attacker something.
    expect(tokensMatch('abc', 'abcdef')).toBe(false)
  })
})

describe('API keys', () => {
  it('is identifiable by prefix and shows a stable display fragment', () => {
    const key = issueApiKey()
    expect(looksLikeApiKey(key.token)).toBe(true)
    expect(key.token.startsWith(key.displayPrefix)).toBe(true)
    // Enough to tell two keys apart in a list, far too little to guess one.
    expect(key.displayPrefix.length).toBeLessThan(key.token.length / 2)
  })

  it('hashes the full token, prefix included', () => {
    const key = issueApiKey()
    expect(hashApiKey(key.token)).toBe(key.hash)
  })

  it('does not mistake a session token for an API key', () => {
    expect(looksLikeApiKey(issueSessionToken().token)).toBe(false)
  })
})

describe('auth mode resolution', () => {
  it('recognises a session cookie', () => {
    expect(resolveAuthMode({ sessionCookie: 'abc' })).toEqual({ kind: 'session', token: 'abc' })
  })

  it('recognises a bearer token', () => {
    expect(resolveAuthMode({ authorizationHeader: 'Bearer smm_live_x' })).toEqual({
      kind: 'apiKey',
      token: 'smm_live_x',
    })
  })

  it('reports anonymous when neither is present', () => {
    expect(resolveAuthMode({})).toEqual({ kind: 'anonymous' })
  })

  // The confused-deputy case. Choosing one by precedence would let an attacker
  // who can set either credential decide which authority applies.
  it('reports a conflict when both are present, rather than picking one', () => {
    expect(
      resolveAuthMode({ sessionCookie: 'abc', authorizationHeader: 'Bearer smm_live_x' })
    ).toEqual({ kind: 'conflict' })
  })

  it('ignores a non-bearer Authorization header', () => {
    expect(resolveAuthMode({ authorizationHeader: 'Basic dXNlcjpwYXNz' })).toEqual({
      kind: 'anonymous',
    })
  })
})

describe('password hashing', () => {
  it('round-trips a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(stored, 'wrong password')).toBe(false)
  }, 20_000)

  it('salts, so identical passwords produce different hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
  }, 20_000)

  it('uses argon2id rather than argon2i or argon2d', async () => {
    expect(await hashPassword('x')).toMatch(/^\$argon2id\$/)
  }, 20_000)

  it('returns false on a malformed stored hash instead of throwing', async () => {
    // A corrupt row must deny the login, not raise a 500 that tells an attacker
    // they found something unusual about this particular account.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false)
  })

  it('does not ask to rehash a current-policy hash', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false)
  }, 20_000)

  it('asks to rehash weaker or unrecognised hashes', () => {
    // Without this, raising the cost only ever protects accounts created after
    // the change — while long-standing accounts, the ones worth attacking, keep
    // their old parameters forever.
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true)
    expect(needsRehash('$2b$12$somethingbcryptish')).toBe(true)
    expect(needsRehash('')).toBe(true)
  })
})
