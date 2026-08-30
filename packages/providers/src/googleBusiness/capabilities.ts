import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Google Business Profile.
 *
 * SKELETON. Requires a Google Cloud project with the Business Profile API enabled, plus per-project access approval from Google.
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
  videoPost: false,
  carousel: false,
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
  reactions: false,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1m', budget: 10, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1m', budget: 10, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 300, unit: 'requests' },
  analytics: { cost: 1, window: '1m', budget: 300, unit: 'requests' },
  scope: 'app',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png'],
    maxCount: 1,
    maxBytes: 5 * MB,
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 1500,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
