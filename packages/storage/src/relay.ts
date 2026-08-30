import { createHmac, timingSafeEqual } from 'node:crypto'
import { loadEnv } from '@smm/config'
import { presignedGetUrl } from './s3.js'

/**
 * The media relay.
 *
 * Instagram FETCHES media from a public HTTPS URL rather than accepting an
 * upload. Many self-hosted deployments expose the app but not object storage, so
 * a presigned S3 URL is unreachable and Instagram simply fails.
 *
 * THERE IS NO SSRF SURFACE HERE, and the shape of the design is why: the relay
 * never accepts a URL. It accepts an opaque HMAC token that resolves to one
 * rendition ID we already own, and streams that object. There is no
 * attacker-controlled destination anywhere in the path. A fetch-by-URL proxy
 * would have had one — that risk was an artifact of one possible implementation,
 * not of the requirement.
 *
 * Security rests on token unguessability, a short TTL, single-asset scope, and
 * per-IP rate limiting. The endpoint is unauthenticated because the fetcher on
 * the other end is anonymous; there is no session to present.
 */

const DEFAULT_TTL_SECONDS = 1800

export type RelayToken = {
  /** The rendition this token grants, and nothing else. */
  id: string
  /**
   * The owning workspace.
   *
   * Carried IN the signed token so the lookup can run under a proper tenant
   * scope. The alternative — a system-scope read — would need a fresh RLS
   * escape for one endpoint, and this is both narrower and more honest: the
   * signature is what makes the workspace claim trustworthy.
   */
  workspaceId: string
  exp: number
}

export class InvalidRelayToken extends Error {
  override readonly name = 'InvalidRelayToken'
  constructor(reason: string) {
    // Never echoes the token. A precise error is an oracle for probing.
    super(`This media link is not valid (${reason}).`)
  }
}

export function signRelayToken(
  mediaId: string,
  workspaceId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS
): string {
  const payload: RelayToken = {
    id: mediaId,
    workspaceId,
    exp: Date.now() + ttlSeconds * 1000,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', loadEnv().SESSION_SECRET).update(body).digest('base64url')
  // '~' rather than '.' as the separator: Fastify's router (find-my-way) treats
  // a dot inside a path parameter as a static suffix boundary, so a dotted token
  // in the last path segment fails to match the route at all — a 404 that looks
  // like a missing asset rather than a routing problem. '~' is unreserved in a
  // URL path and has no such meaning.
  return `${body}~${mac}`
}

export function verifyRelayToken(token: string): RelayToken {
  const parts = token.split('~')
  if (parts.length !== 2) throw new InvalidRelayToken('malformed')

  const [body, mac] = parts as [string, string]
  const expected = createHmac('sha256', loadEnv().SESSION_SECRET).update(body).digest('base64url')

  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidRelayToken('signature mismatch')
  }

  let payload: RelayToken
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RelayToken
  } catch {
    throw new InvalidRelayToken('malformed payload')
  }

  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new InvalidRelayToken('expired')
  }

  return payload
}

export type PublicMediaUrl =
  | { mode: 'presigned-s3'; url: string }
  | { mode: 'relay'; url: string }
  | { mode: 'disabled'; url: null; reason: string }

/**
 * The URL a platform should fetch this media from.
 *
 * `disabled` is a real, supported answer rather than a failure: on a deployment
 * with nothing publicly reachable, Instagram genuinely cannot work, and saying
 * so at connect time is far better than failing at 09:00 when a scheduled post
 * tries to go out.
 */
export async function publicUrlFor(
  mediaId: string,
  workspaceId: string,
  storageKey: string
): Promise<PublicMediaUrl> {
  const env = loadEnv()

  switch (env.MEDIA_PUBLIC_MODE) {
    case 'presigned-s3':
      return { mode: 'presigned-s3', url: await presignedGetUrl(storageKey) }

    case 'relay':
      return {
        mode: 'relay',
        url: new URL(
          `/api/v1/media/relay?t=${encodeURIComponent(signRelayToken(mediaId, workspaceId))}`,
          env.PUBLIC_URL
        ).toString(),
      }

    case 'disabled':
      return {
        mode: 'disabled',
        url: null,
        reason:
          'MEDIA_PUBLIC_MODE is disabled, so platforms that fetch media from a public URL — ' +
          'Instagram among them — cannot retrieve it. Set it to relay or presigned-s3.',
      }
  }
}
