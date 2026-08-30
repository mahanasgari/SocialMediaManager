import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * VK.
 *
 * SKELETON. Requires a VK application and, for community posting, an access token with wall permissions. Availability varies by region.
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
  editPost: true,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: true,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1s', budget: 3, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1s', budget: 3, unit: 'requests' },
  read: { cost: 1, window: '1s', budget: 3, unit: 'requests' },
  analytics: { cost: 1, window: '1s', budget: 3, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'],
    maxCount: 10,
    maxBytes: 50 * MB,
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 16000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
