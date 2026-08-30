import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Medium.
 *
 * SKELETON. Medium's publishing API has been retired to existing integration tokens only. New applications are not being accepted.
 *
 * Kept in the roster and disabled rather than removed. An operator
 * who already holds an integration token has a legitimate reason to look for this
 * connector, and finding it marked unavailable with the reason is more useful
 * than finding nothing and wondering.
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
  draftSupport: true,
  editPost: false,
  deletePost: false,
  retrievePosts: false,
  comments: false,
  replies: false,
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
  publish: { cost: 1, window: '1h', budget: 30, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 30, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  article: {
    mime: ['image/jpeg', 'image/png'],
    maxCount: 20,
    maxBytes: 25 * MB,
  },
}

export const text: TextProfiles = {
  article: {
    maxLength: 100000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    requiresTitle: true,
    titleMaxLength: 100,
  },
}
