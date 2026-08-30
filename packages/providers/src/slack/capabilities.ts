import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Slack.
 *
 * SKELETON. Not yet implemented. Needs a Slack app installed to your workspace — no review required for internal use.
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
  retrievePosts: false,
  comments: true,
  replies: true,
  mentions: true,
  dm: true,
  conversations: true,
  reactions: true,
  analytics: false,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: false,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1m', budget: 60, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1m', budget: 20, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 100, unit: 'requests' },
  analytics: { cost: 1, window: '1m', budget: 20, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'],
    maxCount: 10,
    maxBytes: 1024 * MB,
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 40000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
