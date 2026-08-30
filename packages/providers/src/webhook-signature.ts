import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Shared HMAC verification for inbound webhooks.
 *
 * Every provider signs differently in the details — header name, digest,
 * prefix, sometimes a timestamp in the signed string — but the dangerous parts
 * are identical everywhere, so they live here once rather than being
 * re-derived, subtly differently, twenty-three times.
 */

export type HmacOptions = {
  /** The shared secret. Absent means the operator has not configured it. */
  secret: string | undefined
  /** The value from the provider's signature header. */
  signature: string | undefined
  /** e.g. 'sha256=' on Meta and GitHub. Stripped before comparison. */
  prefix?: string
  algorithm?: 'sha1' | 'sha256'
  /** Prepended to the body before signing, where the provider does that. */
  signedPrefix?: string
}

export type HmacResult = { valid: true } | { valid: false; reason: string }

export function verifyHmac(raw: Buffer, options: HmacOptions): HmacResult {
  const { secret, signature, prefix = '', algorithm = 'sha256', signedPrefix } = options

  // An unconfigured secret is a FAILURE, never a pass.
  //
  // The tempting shortcut — skip verification when no secret is set, so it
  // "works out of the box" — turns the endpoint into an open write into
  // somebody's inbox. If it is not configured, it does not receive.
  if (!secret) return { valid: false, reason: 'no signing secret is configured for this provider' }
  if (!signature) return { valid: false, reason: 'the request carried no signature header' }

  const provided = signature.startsWith(prefix) ? signature.slice(prefix.length) : signature

  const body = signedPrefix ? Buffer.concat([Buffer.from(signedPrefix, 'utf8'), raw]) : raw
  const expected = createHmac(algorithm, secret).update(body).digest('hex')

  // Length is checked first because timingSafeEqual THROWS on a length
  // mismatch rather than returning false — and an uncaught throw here reads as
  // a 500, which tells an attacker their guess had the wrong shape.
  if (provided.length !== expected.length) {
    return { valid: false, reason: 'signature length mismatch' }
  }

  // Constant-time. A byte-by-byte compare that returns early leaks the correct
  // prefix through response timing, and a signature can be recovered a byte at
  // a time from enough samples. This is not theoretical for an endpoint that is
  // public, unauthenticated and accepts unlimited attempts.
  const equal = timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  return equal ? { valid: true } : { valid: false, reason: 'signature did not match' }
}

/**
 * Rejects an event whose timestamp is outside the tolerance.
 *
 * Signature validity alone does not make an event fresh: a captured request
 * replays forever, since its signature stays correct. Providers that include a
 * timestamp in the signed string let us bound that window.
 */
export function withinTolerance(
  timestamp: number | string | undefined,
  toleranceSeconds = 300,
  now: Date = new Date()
): HmacResult {
  if (timestamp === undefined) return { valid: false, reason: 'no timestamp supplied' }

  const seconds = typeof timestamp === 'string' ? Number(timestamp) : timestamp
  if (!Number.isFinite(seconds)) return { valid: false, reason: 'timestamp is not a number' }

  const skew = Math.abs(now.getTime() / 1000 - seconds)
  if (skew > toleranceSeconds) {
    return { valid: false, reason: `timestamp is ${Math.round(skew)}s away from now` }
  }
  return { valid: true }
}
