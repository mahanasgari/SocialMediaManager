import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * WordPress.
 *
 * SKELETON. Not yet implemented. Works against any self-hosted site with the REST API and an application password.
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
  thread: false,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: true,
  editPost: true,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  analytics: false,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: false,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1m', budget: 30, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1m', budget: 30, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 300, unit: 'requests' },
  analytics: { cost: 1, window: '1m', budget: 60, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  article: {
    mime: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'],
    maxCount: 50,
    maxBytes: 100 * MB,
  },
}

export const text: TextProfiles = {
  article: {
    maxLength: 1000000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    requiresTitle: true,
    titleMaxLength: 200,
  },
}
