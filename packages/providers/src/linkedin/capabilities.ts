import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * LinkedIn (personal profile).
 *
 * SKELETON. Requires a LinkedIn app with the Share on LinkedIn product. Self-serve — no partner approval needed for personal profiles.
 *
 * [V] Personal profiles need no partner approval.
 *     https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 *     retrieved 2026-08-29
 *
 * Company Pages require the Marketing Developer Platform instead.
 *
 * This is why profiles and Pages are SEPARATE connectors rather than one with a
 * flag: they have different approval paths, different scopes and different
 * timelines, and merging them would gate the self-serve half behind the one that
 * takes months.
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
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
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
