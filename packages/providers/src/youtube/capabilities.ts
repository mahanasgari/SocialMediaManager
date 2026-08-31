import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * YouTube.
 *
 * IMPLEMENTED. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Requires a Google Cloud project with the YouTube Data API enabled, plus an audit to lift the default upload quota.
 *
 * [V] videos.insert costs 1 unit in the Video Uploads bucket, 100 calls/day —
 * https://developers.google.com/youtube/v3/docs/videos/insert, retrieved 2026-08-31.
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

/**
 * Uploads are metered in their OWN bucket, not the general unit quota.
 *
 * This corrects a figure that was carried in this repository as verified and
 * had gone stale. The plan recorded videos.insert as costing 1600 units of a
 * 10,000-per-day allowance — roughly six uploads a day — and PROVIDERS.md
 * flagged it [A] pending a check against Google's own documentation. Checked:
 * the documentation now describes a separate Video Uploads bucket in which the
 * call costs 1 unit, with 100 calls per day.
 *
 * The practical difference is large enough to matter: six uploads a day is a
 * constraint you design a product around, and a hundred is not. Encoding the
 * old number would have deferred publishing that did not need deferring.
 *
 * mediaUpload carries NO budget deliberately. On YouTube the upload and the
 * publish are one call, so a second budget here would double-count the same
 * request and halve the real allowance. Preparing media locally costs Google
 * nothing.
 *
 * read and analytics stay on the general 10,000-unit quota, where a plain list
 * costs 1 and search.list costs 100 — which is why retrievePosts walks the
 * uploads playlist instead of searching.
 *
 * [V] https://developers.google.com/youtube/v3/docs/videos/insert, retrieved
 * 2026-08-31.
 */
export const limits = {
  publish: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '24h', budget: 10_000, unit: 'quota' },
  analytics: { cost: 1, window: '24h', budget: 10_000, unit: 'quota' },
  // App-scoped: the quota belongs to the Google Cloud project, so every
  // connected channel spends from one pool.
  scope: 'app',
  concurrency: { perAccount: 1, perProvider: 2 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '1h' },
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
