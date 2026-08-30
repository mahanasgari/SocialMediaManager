import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * OAuth state and PKCE.
 *
 * `state` exists to stop CSRF on the callback: without it, an attacker completes
 * an OAuth flow with THEIR account and tricks a victim's browser into hitting
 * our callback, attaching the attacker's social account to the victim's
 * workspace. The state must therefore be unguessable, bound to the initiating
 * user and workspace, single-use, and short-lived.
 *
 * It is signed rather than stored. A signed value needs no round trip and no
 * cleanup job; single-use enforcement still needs a store, but only a tiny
 * short-TTL one keyed by the state's own id.
 */

const STATE_TTL_MS = 10 * 60_000

export type StatePayload = {
  /** Random id, also the single-use key. */
  jti: string
  userId: string
  workspaceId: string
  provider: string
  /** Where to send the browser afterwards. Validated against an allowlist. */
  returnTo: string
  exp: number
}

export class InvalidOAuthState extends Error {
  override readonly name = 'InvalidOAuthState'
  constructor(reason: string) {
    // Never echoes the offending value — a precise error is an oracle.
    super(`The connection link is not valid (${reason}). Start the connection again.`)
  }
}

export function signState(payload: Omit<StatePayload, 'jti' | 'exp'>, secret: string): string {
  const full: StatePayload = {
    ...payload,
    jti: randomBytes(16).toString('base64url'),
    exp: Date.now() + STATE_TTL_MS,
  }
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyState(state: string, secret: string): StatePayload {
  const parts = state.split('.')
  if (parts.length !== 2) throw new InvalidOAuthState('malformed')

  const [body, mac] = parts as [string, string]
  const expected = createHmac('sha256', secret).update(body).digest('base64url')

  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // Length check first: timingSafeEqual throws on a mismatch, and the length of
  // a MAC is public anyway.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidOAuthState('signature mismatch')
  }

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
  } catch {
    throw new InvalidOAuthState('malformed payload')
  }

  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new InvalidOAuthState('expired')
  }

  return payload
}

/**
 * PKCE.
 *
 * The code verifier never leaves us; only its SHA-256 hash goes to the provider.
 * An attacker who intercepts the authorization code cannot exchange it without
 * the verifier — which matters most for the exact case a self-hosted deployment
 * is in: redirects through a browser we do not control.
 */
export function createPkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

/**
 * Redirect allowlisting.
 *
 * An open redirect on an OAuth callback is a credential-stealing primitive: the
 * provider is told to send the browser somewhere the attacker controls, along
 * with whatever is in the URL. Only paths on our own public origin are permitted
 * — never absolute URLs, and never protocol-relative ones.
 */
export function safeReturnTo(candidate: string | undefined, fallback = '/dashboard'): string {
  if (!candidate) return fallback

  // `//evil.com` is protocol-relative and a browser treats it as absolute, so a
  // naive "starts with /" check is not enough.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback
  if (candidate.includes('\\')) return fallback

  return candidate
}

/** Callback URI we hand the provider. Derived, never accepted from the request. */
export function redirectUriFor(publicUrl: string, provider: string): string {
  return new URL(`/api/v1/social-accounts/callback/${provider}`, publicUrl).toString()
}
