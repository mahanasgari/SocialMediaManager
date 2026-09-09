import type { RemotePost } from '../base.js'
import type { BufferChannel, BufferPost, BufferPostInput } from './client.js'

/**
 * The small amount of logic every Buffer-routed connector shares.
 *
 * Kept deliberately small. The Instagram Login report's fourth finding was that
 * "same vendor" is not "same API" and a shared helper that branches internally
 * is harder to read than two that do not — so what lives here is only the part
 * that is genuinely identical whatever network sits behind the route: how a
 * channel list is filtered, how our media becomes Buffer's assets, and how a
 * Buffer post becomes the shape reconciliation compares.
 */

/**
 * Channels of one network.
 *
 * Buffer names the network in `service`, and the casing is not something to
 * trust across a product that has renamed several of these — so the comparison
 * is case-insensitive rather than an exact match that fails silently and
 * reports "no Instagram channels" to someone looking straight at one.
 */
export function channelsOfService(
  channels: readonly BufferChannel[],
  service: string
): BufferChannel[] {
  const wanted = service.toLowerCase()
  return channels.filter((channel) => (channel.service ?? '').toLowerCase() === wanted)
}

/**
 * Our media as Buffer's assets.
 *
 * Buffer fetches these by URL from its own servers, so what we send is a
 * reference and not bytes. A URL that only resolves inside the deployment's
 * network produces a post that fails at Buffer rather than here, which is why
 * the connector's notice says the storage has to be publicly reachable.
 */
export function assetsFor(
  media: ReadonlyArray<{ url: string; mime: string; altText?: string }>
): NonNullable<BufferPostInput['assets']> {
  return media.map((item) =>
    item.mime.startsWith('video/')
      ? { video: { url: item.url } }
      : { image: { url: item.url } }
  )
}

/**
 * A Buffer post in the shape reconciliation compares.
 *
 * `mediaCount` is COUNTED, never assumed. Fingerprint matching rejects any
 * candidate whose media count differs — deliberately, since a provider may
 * rewrite text but will not silently change how many images are attached. A
 * hardcoded zero therefore made every Instagram post unmatchable, because an
 * Instagram post always has media: a lost response would reconcile to "not
 * published", the variant would be retried, and the result is a duplicate
 * public post, which this architecture treats as unrecoverable. Declaring
 * `retrievePosts: true` while returning a count we made up is worse than
 * declaring it false.
 *
 * `createdAt` falls back to the epoch when Buffer omits it. That sounds
 * careless and is the safe direction: retrievePosts callers filter by
 * `createdAt >= since`, so an unknown date drops the post from the comparison
 * window rather than letting an undated row match something it is not.
 */
export function toRemotePost(post: BufferPost): RemotePost {
  return {
    remoteId: post.id,
    createdAt: post.createdAt ? new Date(post.createdAt) : new Date(0),
    text: post.text ?? '',
    mediaCount: post.assets?.length ?? 0,
  }
}
