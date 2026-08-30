import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Instagram.
 *
 * SKELETON. Requires a Meta app, an Instagram Business or Creator account linked to a Facebook Page, and App Review.
 *
 * Instagram PULLS media from a public HTTPS URL rather than
 * accepting an upload, which is why MEDIA_PUBLIC_MODE exists. In `disabled` mode
 * this connector is unavailable at boot with a stated reason rather than failing
 * at publish time.
 *
 * Feed images and Reels have INCOMPATIBLE rules, which is the reason media
 * profiles are keyed by surface rather than by provider — a single provider-keyed
 * profile would encode feed rules and reject every valid Reel.
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
  linkPost: false,
  thread: false,
  story: true,
  reel: true,
  shortVideo: false,
  livePost: false,
  firstComment: true,
  draftSupport: false,
  editPost: false,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  dm: true,
  conversations: true,
  reactions: false,
  analytics: true,
  audienceAnalytics: true,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '24h', budget: 50, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feedImage: {
    // [V] Meta content publishing
    //     https://developers.facebook.com/documentation/instagram-platform/content-publishing
    //     retrieved 2026-08-29
    mime: ['image/jpeg'],
    maxCount: 10,
    maxBytes: 8 * MB,
    aspect: { min: 0.8, max: 1.91 },
  },
  reel: {
    // [V] Meta IG media reference
    //     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
    //     retrieved 2026-08-29
    mime: ['video/mp4', 'video/quicktime'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    aspect: { min: 0.01, max: 10 },
    durationSec: { min: 3, max: 900 },
    // moov atom at the FRONT of the file: `-movflags +faststart`.
    // Without it the upload is accepted and then fails during
    // processing, which is far harder to diagnose than a rejection.
    container: { moovAtomFront: true, closedGop: true, chroma: '4:2:0' },
  },
  story: {
    mime: ['image/jpeg', 'video/mp4'],
    maxCount: 1,
    maxBytes: 100 * MB,
    durationSec: { min: 1, max: 60 },
  },
}

export const text: TextProfiles = {
  feedImage: {
    maxLength: 2200,
    maxHashtags: 30,
    maxMentions: null,
    linkHandling: 'stripped',
  },
  reel: {
    maxLength: 2200,
    maxHashtags: 30,
    maxMentions: null,
    linkHandling: 'stripped',
  },
  story: {
    maxLength: 0,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'stripped',
  },
}
