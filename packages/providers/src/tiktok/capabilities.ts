import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * TikTok.
 *
 * SKELETON. Unaudited apps can only post at private/self-only visibility. Audit is required before anything you publish here can be seen publicly.
 *
 * [V] Unaudited apps post at forced private/self-only visibility.
 * https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 * retrieved 2026-08-29
 *
 * This is why the connector stays a skeleton rather than shipping as
 * "implemented": a scheduler that publishes posts nobody can see, while reporting
 * success, is worse than one that says it is not available.
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
  imagePost: false,
  videoPost: true,
  carousel: false,
  linkPost: false,
  thread: false,
  story: false,
  reel: false,
  shortVideo: true,
  livePost: false,
  firstComment: false,
  draftSupport: false,
  editPost: false,
  /**
   * TikTok exposes no delete in the Content Posting API.
   *
   * Declared true while this was a skeleton, which cost nothing then. Left
   * true now it would put a Delete button in the UI that can only ever fail —
   * and on a published video that is a control people will reach for.
   */
  deletePost: false,
  retrievePosts: true,
  /**
   * Comment read and reply need scopes TikTok grants separately from the
   * Content Posting API, and only to approved use cases.
   *
   * Declared true while this was a skeleton. Left true now, the inbox would
   * offer a TikTok comment view that never fills and a reply box that always
   * fails — worse than not offering it, because it looks supported.
   */
  comments: false,
  replies: false,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '24h', budget: 15, unit: 'requests' },
  mediaUpload: { cost: 1, window: '24h', budget: 15, unit: 'requests' },
  read: { cost: 1, window: '24h', budget: 600, unit: 'requests' },
  analytics: { cost: 1, window: '24h', budget: 600, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  short: {
    mime: ['video/mp4', 'video/quicktime'],
    maxCount: 1,
    maxBytes: 4096 * MB,
    aspect: { min: 0.5, max: 1.0 },
    durationSec: { min: 3, max: 600 },
  },
}

export const text: TextProfiles = {
  short: {
    maxLength: 2200,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'stripped',
  },
}
