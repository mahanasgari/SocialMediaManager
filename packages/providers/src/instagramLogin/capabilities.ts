import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Instagram via Instagram Login — the same network, a different door.
 *
 * IMPLEMENTED. Needs INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET, and Meta App
 * Review before anyone outside the app's test users can connect.
 *
 * A SECOND provider rather than a replacement for `instagram`, deliberately.
 * Accounts already connected through Facebook Login hold Page tokens that this
 * flow cannot refresh or even recognise, and the publishing permission here
 * needs App Review that the existing connector has already been through. One
 * provider serving both would mean every method branching on which kind of
 * token it happened to be holding — and the branch would be invisible in the
 * capability matrix, which is the one place this product promises the truth.
 *
 * What differs from the Facebook Login connector, and why it is declared
 * separately rather than assumed identical:
 *
 *   - NO FACEBOOK PAGE is required, which is the entire reason to prefer it.
 *   - DM IS FALSE. The old connector sends messages to /{pageId}/messages, and
 *     there is no Page here to address. Rather than approximate it, the
 *     capability is false and the method does not exist — the contract suite
 *     enforces that pairing in both directions, so a half-implemented method
 *     behind a false flag cannot reach the UI.
 *   - THE TOKEN REFRESHES. Sixty days, renewable without the person present.
 *
 * Confidence is [A] unless a value carries a source URL and retrieval date.
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  carousel: true,
  linkPost: false,
  thread: false,
  story: true,
  reel: true,
  shortVideo: false,
  livePost: false,
  firstComment: true,
  draftSupport: false,
  /** No caption edit through the API. Delete-and-repost is not an edit. */
  editPost: false,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  /**
   * FALSE, and this is the honest cost of dropping the Facebook Page.
   *
   * Messaging in the old connector goes to /{pageId}/messages. Instagram Login
   * yields no Page, so that endpoint has no address to use. Meta does publish
   * an Instagram messaging surface, but this connector does not implement it,
   * and declaring true while shipping nothing is exactly the dead button this
   * project exists to avoid. Connect through the Facebook Login connector if
   * you need DMs today.
   */
  dm: false,
  conversations: false,
  reactions: false,
  analytics: true,
  audienceAnalytics: true,
  followerMetrics: true,
  contentMetrics: true,
  /** Not implemented here yet — the inbound receiver is Page-subscription based. */
  webhooks: false,
  multiAccount: true,
  /** There are no Pages to discover; the person authorises one account. */
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  /**
   * [V] "100 API-published posts within a 24-hour moving period", carousels
   *     counting as one.
   *     https://developers.facebook.com/docs/instagram-platform/content-publishing
   *     retrieved 2026-09-02
   *
   * Declared at 50 rather than 100: the ceiling is a moving window Meta
   * computes, and spending it exactly means discovering the limit by being
   * refused. Half leaves room for the reconciliation reads that share it.
   */
  publish: { cost: 1, window: '24h', budget: 50, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

/**
 * Identical to the Facebook Login connector's, because the NETWORK is the same.
 *
 * The door changed; Instagram's rules about what a Reel may be did not. These
 * are duplicated rather than imported so that if one flow's rules diverge
 * later, the other does not silently inherit the change.
 */
export const media: MediaProfiles = {
  feedImage: {
    // [V] https://developers.facebook.com/docs/instagram-platform/content-publishing
    //     retrieved 2026-09-02
    mime: ['image/jpeg'],
    maxCount: 10,
    maxBytes: 8 * MB,
    aspect: { min: 0.8, max: 1.91 },
  },
  reel: {
    // [V] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
    //     retrieved 2026-08-29
    mime: ['video/mp4', 'video/quicktime'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    aspect: { min: 0.01, max: 10 },
    durationSec: { min: 3, max: 900 },
    container: { moovAtomFront: true, closedGop: true, chroma: '4:2:0' },
  },
  story: {
    mime: ['image/jpeg', 'video/mp4'],
    maxCount: 1,
    maxBytes: 100 * MB,
    durationSec: { min: 1, max: 60 },
  },
}

export const text: TextProfiles = {
  feedImage: { maxLength: 2200, maxHashtags: 30, maxMentions: null, linkHandling: 'stripped' },
  reel: { maxLength: 2200, maxHashtags: 30, maxMentions: null, linkHandling: 'stripped' },
  story: { maxLength: 0, maxHashtags: null, maxMentions: null, linkHandling: 'stripped' },
}
