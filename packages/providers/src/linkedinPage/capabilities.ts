import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * LinkedIn Company Page.
 *
 * SKELETON. Requires Marketing Developer Platform approval, which is a manual review with no published timeline. [A] Reports suggest 3-4 months.
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
  carousel: true,
  linkPost: true,
  thread: false,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: false,
  editPost: false,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: true,
  analytics: true,
  audienceAnalytics: true,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '24h', budget: 500, unit: 'requests' },
  analytics: { cost: 1, window: '24h', budget: 500, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'video/mp4'],
    maxCount: 9,
    maxBytes: 10 * MB,
    durationSec: { min: 3, max: 600 },
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 3000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
