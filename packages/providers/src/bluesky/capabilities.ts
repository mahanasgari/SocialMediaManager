import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Bluesky (AT Protocol).
 *
 * Chosen as an early real connector because it needs no app review, no partner
 * programme and no payment — the whole flow is available to anyone with an
 * account today.
 *
 * [V] com.atproto.repo.createRecord and app.bsky.feed.post
 *     https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 *     retrieved 2026-08-29
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  carousel: false,
  linkPost: true,
  /** Replies chain via the reply ref, which is how a thread is built. */
  thread: true,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  /** A first comment is just a reply to your own post. */
  firstComment: true,
  draftSupport: false,
  /** AT Protocol records are immutable; an "edit" is a delete plus a create. */
  editPost: false,
  deletePost: true,
  /**
   * The repo is readable, which is what makes exactly-once publishing possible
   * here: after a lost response we can list recent records and reconcile rather
   * than risking a duplicate.
   */
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  dm: false,
  conversations: false,
  reactions: true,
  /**
   * Like and repost counts live on the post record itself. There is no insights
   * API — no impressions, no reach — and the UI must render those as "—" rather
   * than zero.
   */
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

/**
 * [V] Points-based rate limiting: ~1,666 record creations per hour per account.
 *     https://docs.bsky.app/docs/advanced-guides/rate-limits
 *     retrieved 2026-08-29
 *
 * The daily ceiling is NOT 24x the hourly one.
 *
 * Budgeted well under the documented ceiling. The limit is shared with likes,
 * follows and reposts, so a scheduler that spent it all on posts would break
 * every other interaction the account makes.
 */
export const limits = {
  publish: { cost: 1, window: '1h', budget: 300, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 600, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 3000, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 1000, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 8 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    // [V] Blob upload rejects anything over 1,000,000 bytes.
    //     https://docs.bsky.app/docs/advanced-guides/posts  retrieved 2026-08-29
    maxBytes: 976_562,
    maxCount: 4,
    altTextMaxLength: 2000,
  },
  feedImage: {
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    maxBytes: 976_562,
    maxCount: 4,
    altTextMaxLength: 2000,
  },
  feedVideo: {
    mime: ['video/mp4'],
    maxBytes: 50 * MB,
    maxCount: 1,
    durationSec: { min: 1, max: 180 },
    videoCodec: ['h264'],
  },
}

export const text: TextProfiles = {
  feed: {
    /**
     * 300 GRAPHEMES, not characters.
     *
     * This is exactly why the shared validator counts graphemes: an emoji with a
     * skin-tone modifier is one character to Bluesky and four UTF-16 code units
     * to String.length, so naive counting rejects posts the network accepts.
     */
    maxLength: 300,
    maxHashtags: null,
    maxMentions: null,
    /**
     * Links are counted in FULL — Bluesky does not shorten. A long URL really
     * does eat a third of the limit, which the composer must show honestly
     * rather than discovering at publish time.
     */
    linkHandling: 'counted',
  },
  feedImage: {
    maxLength: 300,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    mediaRequired: true,
  },
  feedVideo: {
    maxLength: 300,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    mediaRequired: true,
  },
}
