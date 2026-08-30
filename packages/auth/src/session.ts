import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Session and API-key token handling.
 *
 * Session IDs are opaque random values, NOT JWTs. The trade is deliberate: a JWT
 * avoids a database lookup, but cannot be revoked without a denylist — which
 * reintroduces exactly the server-side session state it was meant to remove,
 * only worse, because now there are two sources of truth. Sessions live in
 * Postgres so they can be listed in a "your devices" view and revoked
 * immediately; Redis caches them with a short TTL, and revocation busts it.
 */

const TOKEN_BYTES = 32 // 256 bits

export type IssuedToken = {
  /** Given to the client. Never stored. */
  token: string
  /** Stored. The plaintext is unrecoverable from this. */
  hash: string
}

/**
 * Hashing is a single SHA-256 rather than a password KDF.
 *
 * That is correct here and wrong for passwords. A KDF's cost exists to make
 * guessing a LOW-ENTROPY secret expensive. These tokens carry 256 bits of
 * entropy from a CSPRNG, so guessing is already infeasible and stretching would
 * only add latency to every authenticated request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function issueSessionToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashSessionToken(token: string): string {
  return hashToken(token)
}

/**
 * Constant-time comparison. Length is compared first because timingSafeEqual
 * throws on a length mismatch — and returning early on length is safe, since the
 * length of a hex digest is public.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = 'smm_live_'

export type IssuedApiKey = IssuedToken & {
  /** Stored alongside the hash so the UI can show which key is which. */
  displayPrefix: string
}

/**
 * API keys are shown ONCE at creation and never again — only the hash is
 * retained. The display prefix exists so a user can tell two keys apart in a
 * list without the secret being recoverable.
 */
export function issueApiKey(): IssuedApiKey {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url')
  const token = `${API_KEY_PREFIX}${secret}`
  return {
    token,
    hash: hashToken(token),
    displayPrefix: token.slice(0, API_KEY_PREFIX.length + 6),
  }
}

export function hashApiKey(token: string): string {
  return hashToken(token)
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX)
}

// ---------------------------------------------------------------------------
// Auth mode
// ---------------------------------------------------------------------------

export type AuthMode =
  | { kind: 'session'; token: string }
  | { kind: 'apiKey'; token: string }
  | { kind: 'anonymous' }
  | { kind: 'conflict' }

/**
 * Resolves which credential a request presents.
 *
 * A request carrying BOTH a session cookie and an API key resolves to
 * `conflict`, and the caller must reject it — never pick one by precedence.
 *
 * This is where public-API-plus-web-app products usually get owned: a
 * browser-borne request that silently upgrades to API-key authority is a
 * confused deputy, and an attacker who can set either credential gets to choose
 * which one wins. Rejecting the ambiguity costs one error path and removes the
 * whole class.
 */
export function resolveAuthMode(input: {
  sessionCookie?: string | undefined
  authorizationHeader?: string | undefined
}): AuthMode {
  const bearer = input.authorizationHeader?.startsWith('Bearer ')
    ? input.authorizationHeader.slice('Bearer '.length).trim()
    : undefined

  const hasSession = Boolean(input.sessionCookie)
  const hasKey = Boolean(bearer)

  if (hasSession && hasKey) return { kind: 'conflict' }
  if (hasKey) return { kind: 'apiKey', token: bearer! }
  if (hasSession) return { kind: 'session', token: input.sessionCookie! }
  return { kind: 'anonymous' }
}
