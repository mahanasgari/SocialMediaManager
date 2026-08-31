import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Pinterest.
 *
 * SKELETON. Trial access creates sandbox pins visible only to their creator. Standard access is required before pins are real.
 *
 * [V] Trial = sandbox pins visible only to the creator.
 * https://developers.pinterest.com/docs/key-concepts/access-tiers/
 * retrieved 2026-08-29
 *
 * Same reasoning as TikTok: publishing invisible content while reporting success
 * is the failure mode the honesty policy exists to prevent.
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
  deletePost: true,
  retrievePosts: true,
  /**
   * Pinterest v5 exposes no endpoint for reading the comments on a Pin.
   *
   * Declared true while this was a skeleton, which cost nothing then and would
   * now put a comment view in the inbox that can never fill. False until
   * Pinterest ships a read path — the contract test is what caught it.
   */
  comments: false,
  replies: false,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  analytics: true,
  audienceAnalytics: true,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 1000, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 1000, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  pin: {
    mime: ['image/jpeg', 'image/png', 'video/mp4'],
    maxCount: 1,
    maxBytes: 20 * MB,
    aspect: { min: 0.5, max: 1.0 },
    recommendedAspect: 0.666,
  },
}

export const text: TextProfiles = {
  pin: {
    maxLength: 500,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    requiresTitle: true,
    titleMaxLength: 100,
  },
}
