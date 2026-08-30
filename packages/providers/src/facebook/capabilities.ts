import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Facebook Pages.
 *
 * SKELETON. Requires a Meta app with pages_manage_posts, and App Review before it can post to Pages you do not own.
 *
 * Publishing is two-phase for media: a container is created, then
 * published. The container can fail during processing AFTER we have been told the
 * upload succeeded, which is why `pending` exists on PublishResult.
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
  story: true,
  reel: true,
  shortVideo: false,
  livePost: false,
  firstComment: true,
  draftSupport: false,
  editPost: true,
  deletePost: true,
  retrievePosts: true,
  comments: true,
  replies: true,
  mentions: true,
  dm: false,
  conversations: false,
  reactions: true,
  analytics: true,
  audienceAnalytics: true,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: true,
} as const satisfies ProviderCapabilities

export const limits = {
  publish: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 200, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 600, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 600, unit: 'requests' },
  scope: 'app',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png'],
    maxCount: 10,
    maxBytes: 10 * MB,
    aspect: { min: 0.4, max: 3.0 },
  },
  feedVideo: {
    mime: ['video/mp4'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    durationSec: { min: 1, max: 7200 },
  },
  reel: {
    mime: ['video/mp4'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    aspect: { min: 0.5, max: 0.6 },
    durationSec: { min: 3, max: 90 },
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 63206,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
  feedVideo: {
    // Same allowance as a text post: the description field on a video is the
    // post body, not a caption.
    maxLength: 63206,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
  reel: {
    maxLength: 2200,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
