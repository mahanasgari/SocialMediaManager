/**
 * What our server is allowed to request on a user's behalf.
 *
 * Two features take a URL from a user and cause a server-side request to it:
 * RSS ingestion and outbound webhooks. That is the definition of an SSRF
 * surface, and the check is shared because the risk is identical — a webhook
 * pointed at 169.254.169.254 would deliver our own cloud metadata to whoever
 * asked for it, exactly as a feed would.
 *
 * Zero dependencies, no I/O. It answers "may we request this address", not
 * "does this address work".
 */

export class UnsafeFeedUrl extends Error {
  override readonly name = 'UnsafeFeedUrl'
  constructor(reason: string) {
    super(`That address cannot be fetched (${reason}).`)
  }
}

/**
 * Rejects addresses that could reach infrastructure rather than the internet.
 *
 * Must be called BEFORE connecting and again after every redirect. A redirect to
 * a link-local address is the classic way an allowlisted hostname turns into a
 * cloud metadata read, and checking only the address the user typed catches none
 * of it.
 *
 * This is necessary but NOT sufficient on its own: a hostname that resolves to a
 * private address passes here and is caught only by re-checking each hop. That
 * limitation is stated rather than hidden, because a check that looks complete
 * is more dangerous than one known to be partial.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeFeedUrl('not a valid address')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeFeedUrl('only http and https are supported')
  }

  const host = url.hostname.toLowerCase()

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeFeedUrl('that address is on this machine or a private network')
  }

  if (isPrivateAddress(host)) {
    throw new UnsafeFeedUrl('that address is on a private network')
  }

  return url
}

/** Literal IPs in ranges that are never a legitimate public destination. */
export function isPrivateAddress(host: string): boolean {
  // IPv6 loopback and unique-local.
  if (host === '::1' || host === '[::1]') return true
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host)) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) return false

  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // Link-local, which is where cloud metadata endpoints live.
  if (a === 169 && b === 254) return true
  return false
}
