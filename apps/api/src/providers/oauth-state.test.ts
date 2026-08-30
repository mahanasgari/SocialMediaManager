import { describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import {
  InvalidOAuthState,
  createPkce,
  redirectUriFor,
  safeReturnTo,
  signState,
  verifyState,
} from './oauth-state.js'

const SECRET = 'a'.repeat(44)
const OTHER_SECRET = 'b'.repeat(44)

const payload = {
  userId: '018f5c00-0000-7000-8000-000000000001',
  workspaceId: '018f5c00-0000-7000-8000-000000000002',
  provider: 'mock',
  returnTo: '/dashboard',
}

describe('state signing', () => {
  it('round-trips the binding fields', () => {
    const verified = verifyState(signState(payload, SECRET), SECRET)
    expect(verified.userId).toBe(payload.userId)
    expect(verified.workspaceId).toBe(payload.workspaceId)
    expect(verified.provider).toBe('mock')
  })

  it('binds the state to a user AND a workspace', () => {
    // Without this binding, an attacker completes an OAuth flow with THEIR
    // account and tricks a victim's browser into hitting our callback —
    // attaching the attacker's social account to the victim's workspace.
    const verified = verifyState(signState(payload, SECRET), SECRET)
    expect(verified).toMatchObject({
      userId: payload.userId,
      workspaceId: payload.workspaceId,
    })
  })

  it('rejects a state signed with a different secret', () => {
    expect(() => verifyState(signState(payload, OTHER_SECRET), SECRET)).toThrow(InvalidOAuthState)
  })

  it('rejects a tampered payload', () => {
    // The whole attack: swap the workspace id for one you do not own.
    const signed = signState(payload, SECRET)
    const [body, mac] = signed.split('.') as [string, string]
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    decoded['workspaceId'] = '018f5c00-0000-7000-8000-0000000000ff'
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')

    expect(() => verifyState(`${tampered}.${mac}`, SECRET)).toThrow(InvalidOAuthState)
  })

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET)).toThrow(InvalidOAuthState)
    expect(() => verifyState('', SECRET)).toThrow(InvalidOAuthState)
    expect(() => verifyState('a.b.c', SECRET)).toThrow(InvalidOAuthState)
  })

  it('rejects an expired state', () => {
    const signed = signState(payload, SECRET)
    const [body] = signed.split('.') as [string]
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    decoded['exp'] = Date.now() - 1000

    // Re-signed properly, so only expiry can reject it — proving the TTL is
    // enforced rather than incidentally caught by the signature check.
    const newBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    const mac = createHmac('sha256', SECRET).update(newBody).digest('base64url')

    expect(() => verifyState(`${newBody}.${mac}`, SECRET)).toThrow(/expired/)
  })

  it('issues a unique single-use id per flow', () => {
    const a = verifyState(signState(payload, SECRET), SECRET)
    const b = verifyState(signState(payload, SECRET), SECRET)
    expect(a.jti).not.toBe(b.jti)
  })

  it('does not echo the offending value in the error', () => {
    // A precise error is an oracle for probing what we accept.
    try {
      verifyState('deadbeef.cafebabe', SECRET)
    } catch (err) {
      expect((err as Error).message).not.toContain('deadbeef')
    }
  })
})

describe('PKCE', () => {
  it('produces an S256 challenge distinct from the verifier', () => {
    const pkce = createPkce()
    expect(pkce.method).toBe('S256')
    expect(pkce.challenge).not.toBe(pkce.verifier)
  })

  it('the challenge is the SHA-256 of the verifier, base64url', () => {
    const pkce = createPkce()
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
  })

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkce().verifier))
    expect(seen.size).toBe(200)
  })
})

describe('redirect allowlisting', () => {
  // An open redirect on an OAuth callback is a credential-stealing primitive:
  // the provider is told to send the browser somewhere the attacker controls.
  it('allows a same-origin path', () => {
    expect(safeReturnTo('/settings/accounts')).toBe('/settings/accounts')
  })

  it('rejects an absolute URL', () => {
    expect(safeReturnTo('https://evil.example/steal')).toBe('/dashboard')
  })

  it('rejects a protocol-relative URL', () => {
    // The one a naive "starts with /" check lets straight through: a browser
    // treats //evil.example as absolute.
    expect(safeReturnTo('//evil.example/steal')).toBe('/dashboard')
  })

  it('rejects a backslash-obfuscated URL', () => {
    // Some browsers normalise backslashes to forward slashes in paths.
    expect(safeReturnTo('/\\evil.example')).toBe('/dashboard')
    expect(safeReturnTo('\\\\evil.example')).toBe('/dashboard')
  })

  it('rejects a javascript: URL', () => {
    expect(safeReturnTo('javascript:alert(1)')).toBe('/dashboard')
  })

  it('falls back when absent', () => {
    expect(safeReturnTo(undefined)).toBe('/dashboard')
    expect(safeReturnTo('')).toBe('/dashboard')
  })
})

describe('redirect URI derivation', () => {
  it('is derived from PUBLIC_URL, never taken from the request', () => {
    // Accepting a redirect_uri from the caller would let an attacker point the
    // provider's callback at their own server.
    expect(redirectUriFor('https://social.example.com', 'mastodon')).toBe(
      'https://social.example.com/api/v1/social-accounts/callback/mastodon'
    )
  })

  it('handles a public URL with a trailing path', () => {
    expect(redirectUriFor('https://example.com/', 'mock')).toBe(
      'https://example.com/api/v1/social-accounts/callback/mock'
    )
  })
})
