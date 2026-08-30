import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Outbound webhook signatures.
 *
 * Shared between the worker, which signs real deliveries, and the API, which
 * signs test deliveries. If these ever diverged, a customer would verify our
 * tests successfully and our real events not at all — a failure that only shows
 * up in production, on somebody else's system.
 */

/**
 * `t=<unix>,v1=<hex>` over `${timestamp}.${body}`.
 *
 * The timestamp is INSIDE the signed string, not merely alongside it. Signing
 * the body alone would let a captured request be replayed forever, because its
 * signature never stops being correct.
 */
export function sign(body: string, secret: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

/**
 * The check a consumer writes, provided so the documented recipe is executable
 * rather than prose someone has to reimplement from a paragraph.
 */
export function verify(
  header: string,
  body: string,
  secret: string,
  toleranceSeconds = 300,
  now: Date = new Date()
): { valid: true } | { valid: false; reason: string } {
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=')
      return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
    })
  )

  const timestamp = Number(parts['t'])
  const provided = parts['v1']
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'no usable timestamp' }
  if (!provided) return { valid: false, reason: 'no v1 signature' }

  // Freshness is checked separately from correctness: a valid signature on an
  // hour-old request is a replay, and rejecting it needs its own reason so an
  // operator debugging clock skew is not told the signature was wrong.
  const skew = Math.abs(now.getTime() / 1000 - timestamp)
  if (skew > toleranceSeconds) {
    return { valid: false, reason: `timestamp is ${Math.round(skew)}s away from now` }
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  // Length first: timingSafeEqual THROWS on a mismatch rather than returning
  // false, and an uncaught throw here becomes a 500 that tells an attacker their
  // guess had the wrong shape.
  if (provided.length !== expected.length) return { valid: false, reason: 'signature length mismatch' }

  const equal = timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  return equal ? { valid: true } : { valid: false, reason: 'signature did not match' }
}
