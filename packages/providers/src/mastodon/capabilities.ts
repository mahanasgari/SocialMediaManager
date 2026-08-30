import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Mastodon — the Phase 4 publishing anchor.
 *
 * Chosen because it exercises the parts of the publishing pipeline a mock
 * cannot: real OAuth2 with PER-INSTANCE app registration, media upload that
 * returns BEFORE processing finishes, a native idempotency header, real
 * rate-limit headers, and genuine read-back for reconciliation.
 *
 * It also needs no app review, no partner programme and no payment, so anyone
 * reading this repository can actually run it.
 *
 * [V] Status creation, media, and the Idempotency-Key header
 *     https://docs.joinmastodon.org/methods/statuses/
 *     retrieved 2026-08-30
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  /** Up to four attachments on one status; not a distinct carousel surface. */
  carousel: false,
  linkPost: true,
  /** in_reply_to_id chains statuses into a thread. */
  thread: true,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  /** A first comment is a self-reply, which is how threads work here anyway. */
  firstComment: true,
  /**
   * FALSE. Mastodon has scheduled_at, but scheduling is OURS — the calendar,
   * the approval gate, the catch-up window and the MISSED state all live here.
   * Handing a status to the instance to publish later would put half the
   * schedule somewhere we cannot edit, cancel, or report on.
   */
  draftSupport: false,
  /**
   * [V] Editing exists and preserves the status id, so a remoteId stays valid.
   *     https://docs.joinmastodon.org/methods/statuses/#edit
   *     retrieved 2026-08-30
   */
  editPost: true,
  deletePost: true,
  /**
   * TRUE, and this is why Mastodon is the anchor for the idempotency design.
   *
   * The account timeline is readable, so after a lost response we can list
   * recent statuses and reconcile against a fingerprint rather than risking a
   * duplicate. This is the branch that MockProvider could only pretend to
   * exercise.
   */
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  /** Direct-visibility statuses exist, but they are not a DM system. */
  dm: false,
  conversations: false,
  reactions: true,
  /**
   * Favourite, boost and reply counts live on the status itself. There is NO
   * insights API — no impressions, no reach — so those must render as "—"
   * rather than as zero.
   */
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  /** Streaming exists, but it is a socket, not a signed inbound webhook. */
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

/**
 * [V] Default 300 requests per 5 minutes per account.
 *     https://docs.joinmastodon.org/api/rate-limits/
 *     retrieved 2026-08-30
 *
 * Status creation has a much tighter ceiling than the general limit.
 *
 * Budgeted well under both. These are INSTANCE defaults that any admin can
 * change, in either direction, which is exactly why the adaptive correction on
 * a 429 matters more here than the declared numbers do — a small instance may
 * be far stricter than the documented default.
 */
export const limits = {
  publish: { cost: 1, window: '30m', budget: 20, unit: 'requests' },
  mediaUpload: { cost: 1, window: '30m', budget: 40, unit: 'requests' },
  read: { cost: 1, window: '5m', budget: 200, unit: 'requests' },
  analytics: { cost: 1, window: '5m', budget: 200, unit: 'requests' },
  /** Per account: the limit follows the token, and each token is one account. */
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 8 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ],
    /** [V] Four attachments per status. https://docs.joinmastodon.org/methods/statuses/ retrieved 2026-08-30 */
    maxCount: 4,
    /**
     * Instance-configurable, commonly 8 MB for images and 40 MB for video. The
     * LOWER figure is used because the composer cannot know which branch a file
     * takes, and rejecting early with a clear message beats a provider error at
     * publish time.
     */
    maxBytes: 8 * MB,
    altTextMaxLength: 1500,
  },
}

export const text: TextProfiles = {
  feed: {
    /**
     * 500 is the DEFAULT, not the rule. Instances routinely raise it, and the
     * real value is read from /api/v2/instance at connect time and stored on the
     * account. This figure is the floor used before an instance has answered.
     */
    maxLength: 500,
    maxHashtags: null,
    maxMentions: null,
    /**
     * Every URL counts as 23 characters regardless of its real length, so a
     * naive character count rejects posts the instance would have accepted.
     * [V] https://docs.joinmastodon.org/user/posting/#links retrieved 2026-08-30
     */
    linkHandling: 'shortened',
    shortenedLinkLength: 23,
  },
}
