import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * YouTube.
 *
 * SKELETON. Requires a Google Cloud project with the YouTube Data API enabled, plus an audit to lift the default upload quota.
 *
 * [V] videos.insert costs 1600 units of a 10,000/day default quota.
 *     https://developers.google.com/youtube/v3/determine_quota_cost
 *     retrieved 2026-08-29
 *
 * That is roughly SIX UPLOADS PER DAY.
 *
 * This cannot be handled reactively. Discovering the limit by hitting it burns a
 * day's uploads, so the budget is declared here and acquired before the call.
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
  publish: { cost: 1600, window: '24h', budget: 10000, unit: 'quota' },
  mediaUpload: { cost: 1600, window: '24h', budget: 10000, unit: 'quota' },
  read: { cost: 1, window: '24h', budget: 10000, unit: 'quota' },
  analytics: { cost: 1, window: '24h', budget: 10000, unit: 'quota' },
  scope: 'app',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feedVideo: {
    mime: ['video/mp4', 'video/quicktime', 'video/x-matroska'],
    maxCount: 1,
    maxBytes: 131072 * MB,
    durationSec: { min: 1, max: 43200 },
  },
  short: {
    mime: ['video/mp4'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    aspect: { min: 0.5, max: 1.0 },
    durationSec: { min: 1, max: 60 },
  },
}

export const text: TextProfiles = {
  feedVideo: {
    maxLength: 5000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    requiresTitle: true,
    titleMaxLength: 100,
  },
  short: {
    maxLength: 5000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
    requiresTitle: true,
    titleMaxLength: 100,
  },
}
