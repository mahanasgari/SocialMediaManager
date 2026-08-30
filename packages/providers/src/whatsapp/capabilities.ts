import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * WhatsApp Business.
 *
 * SKELETON. Requires a WhatsApp Business Account, a verified business, and approved message templates. Outbound messages outside a 24-hour window must use a pre-approved template.
 *
 * Not a broadcast channel, and the composer should not treat it as
 * one. WhatsApp is conversational: outside a 24-hour customer-initiated window,
 * only pre-approved templates may be sent. Modelling it as "another network to
 * post to" would produce messages that are silently rejected.
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
  draftSupport: false,
  editPost: false,
  deletePost: false,
  retrievePosts: false,
  comments: false,
  replies: true,
  mentions: false,
  dm: true,
  conversations: true,
  reactions: false,
  analytics: false,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: false,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1s', budget: 80, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1s', budget: 80, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 600, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'video/mp4'],
    maxCount: 1,
    maxBytes: 16 * MB,
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 4096,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
