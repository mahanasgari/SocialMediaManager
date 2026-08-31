import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Facebook Pages.
 *
 * IMPLEMENTED. Needs META_APP_ID and META_APP_SECRET, and App Review for
 * pages_manage_posts before it can post to Pages the app does not own.
 *
 * Two capabilities are declared FALSE that Facebook itself supports, and the
 * reason is the same for both: Reels and Stories are separate resumable-upload
 * flows against different endpoints (/video_reels, /photo_stories), not a
 * parameter on a feed post. Declaring them true would put a surface in the
 * composer that fails at publish time, which is the dead control the honesty
 * policy exists to prevent. They become true when those flows are written.
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
  /** See the note above: a separate upload flow, not built. */
  story: false,
  /** See the note above: a separate upload flow, not built. */
  reel: false,
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

/**
 * Meta rate limits are a POINTS budget, not a request count.
 *
 * The published model is roughly 4800 × (engaged users) points per rolling
 * hour per app, and a write costs several times a read — so a fixed
 * requests-per-hour number is a simplification. It is deliberately
 * conservative: exceeding the real limit costs a 4/17/32 error and a cooldown
 * that affects every account on the app, and the adaptive correction in
 * packages/ratelimit widens this from observed 429s rather than us guessing
 * high.
 *
 * [V] Rate limiting model — https://developers.facebook.com/docs/graph-api/overview/rate-limiting,
 * retrieved 2026-08-31.
 */
export const limits = {
  publish: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 400, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 400, unit: 'requests' },
  // App-scoped, not per account. Meta counts against the APP, so applying this
  // per account would let ten Pages spend ten times the real budget.
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
  // No reel profile, deliberately. The capability is false, and a profile for a
  // surface the composer cannot publish to would describe constraints on
  // something that does not work.
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

}
