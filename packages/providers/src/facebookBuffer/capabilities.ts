import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Facebook Pages reached through Buffer.
 *
 * IMPLEMENTED. Needs a Buffer API key per workspace and a Facebook Page channel
 * already connected inside that Buffer account. Like the Instagram route, it
 * needs nothing from Meta — no app, no App Review.
 *
 * The engagement losses are identical to the Instagram route and are described
 * there. What differs is what Facebook itself allows, and those differences are
 * the reason this is a separate declaration rather than a copy:
 *
 *   - TEXT-ONLY POSTS ARE REAL HERE. Instagram refuses a post with no media;
 *     Facebook has always accepted a status update. So `publish` does not
 *     require media, and a composer that assumed the Instagram rule would block
 *     a perfectly valid post.
 *   - LINKS SURVIVE. Instagram strips them from captions and Facebook renders
 *     them, which changes `linkHandling` from 'stripped' to 'counted' and is
 *     exactly the kind of per-network rule the surface profiles exist to hold.
 *   - THE LIMIT IS 63,206 CHARACTERS, not 2,200. A caption written for Facebook
 *     and validated against Instagram's ceiling would be refused for no reason.
 *
 * Confidence is [A] unless a value carries a source URL and retrieval date.
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  carousel: false,
  /** Facebook renders links rather than stripping them. */
  linkPost: true,
  thread: false,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: true,
  /** Buffer can edit only what it has not sent. Once on Facebook, neither can. */
  editPost: false,
  /** Buffer's delete removes Buffer's record, not the published Facebook post. */
  deletePost: false,
  retrievePosts: true,
  comments: false,
  replies: false,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: true,
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  /** [A] Buffer publishes no numeric limits; see the Instagram route's note. */
  publish: { cost: 1, window: '24h', budget: 50, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 120, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 120, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

/**
 * `feed` here, unlike the Instagram route's feedImage/feedVideo.
 *
 * Facebook's feed takes text alone, an image or a video under one set of rules,
 * so splitting it by media type would invent a distinction the network does not
 * make — and would leave a text-only post with no surface to belong to.
 */
export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'video/mp4'],
    maxCount: 1,
    maxBytes: 100 * MB,
  },
}

export const text: TextProfiles = {
  feed: { maxLength: 63_206, maxHashtags: null, maxMentions: null, linkHandling: 'counted' },
}
