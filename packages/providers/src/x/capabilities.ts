import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * X.
 *
 * SKELETON. Requires an X developer account. Posting is PAID PER POST on the default tier — see the cost warning in the composer before enabling.
 *
 * [V] Pay-per-use since Feb 2026: $0.015/post, $0.20/post containing a URL.
 *     https://docs.x.com/x-api/getting-started/pricing
 *     retrieved 2026-08-29
 *
 * The URL surcharge is more than 13x the base rate, so the composer warns
 * specifically on link posts rather than showing one flat estimate. A workspace
 * spend cap is enforced before publish, not after.
 *
 * The capability, media and text declarations below are REAL and are used by the
 * composer to preview constraints, even though publishing is blocked. Declaring
 * them now is what makes the eventual implementation a matter of writing the
 * adapter rather than also discovering the rules.
 *
 * Confidence is [A] unless a value carries a source URL and retrieval date.
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  carousel: false,
  linkPost: true,
  thread: true,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: false,
  editPost: true,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  dm: true,
  conversations: true,
  reactions: true,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '15m', budget: 60, unit: 'requests' },
  analytics: { cost: 1, window: '15m', budget: 60, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'],
    maxCount: 4,
    maxBytes: 5 * MB,
    durationSec: { min: 1, max: 140 },
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 280,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'shortened',
    shortenedLinkLength: 23,
  },
}
