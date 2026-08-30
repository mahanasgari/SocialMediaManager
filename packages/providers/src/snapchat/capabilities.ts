import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Snapchat.
 *
 * SKELETON. Content publishing is restricted to approved marketing partners. There is no self-serve path.
 *
 * The capability, media and text declarations below are REAL and are used by the
 * composer to preview constraints, even though publishing is blocked. Declaring
 * them now is what makes the eventual implementation a matter of writing the
 * adapter rather than also discovering the rules.
 *
 * Confidence is [A] unless a value carries a source URL and retrieval date.
 */
export const capabilities = {
  textPost: false,
  imagePost: true,
  videoPost: true,
  carousel: false,
  linkPost: false,
  thread: false,
  story: true,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: false,
  editPost: false,
  deletePost: false,
  retrievePosts: false,
  comments: false,
  replies: false,
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
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1h', budget: 20, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 20, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  story: {
    mime: ['image/jpeg', 'video/mp4'],
    maxCount: 1,
    maxBytes: 32 * MB,
    aspect: { min: 0.5, max: 0.6 },
    durationSec: { min: 3, max: 180 },
  },
}

export const text: TextProfiles = {
  story: {
    maxLength: 80,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'stripped',
  },
}
