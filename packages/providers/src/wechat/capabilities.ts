import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * WeChat Official Account.
 *
 * SKELETON. Requires a verified WeChat Official Account, which in most cases requires a mainland China business licence. There is no self-serve path for overseas operators.
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
  linkPost: false,
  thread: false,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: true,
  editPost: false,
  deletePost: true,
  retrievePosts: false,
  comments: true,
  replies: true,
  mentions: false,
  dm: true,
  conversations: true,
  reactions: false,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '24h', budget: 1, unit: 'requests' },
  mediaUpload: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 300, unit: 'requests' },
  analytics: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  article: {
    mime: ['image/jpeg', 'image/png'],
    maxCount: 20,
    maxBytes: 10 * MB,
  },
}

export const text: TextProfiles = {
  article: {
    maxLength: 20000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'stripped',
    requiresTitle: true,
    titleMaxLength: 64,
  },
}
