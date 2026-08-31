import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * LinkedIn — personal profiles.
 *
 * IMPLEMENTED. Needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, and the
 * Share on LinkedIn product on the app. Self-serve: no partner review.
 *
 * Several capabilities below are FALSE that LinkedIn itself supports, and the
 * reason is one thing: the self-serve tier grants `w_member_social` and the
 * OIDC scopes, and nothing else. Reading a member's own posts, their comments,
 * their reactions or their post analytics all need `r_member_social`, which is
 * not self-serve.
 *
 * Declaring them true would put an inbox that never fills and metrics that stay
 * empty in front of someone who would reasonably conclude the product is
 * broken. False is the honest description of what a self-serve app can do.
 *
 * retrievePosts: false has a consequence worth stating plainly, because it
 * reaches the publishing pipeline rather than only the UI. With no read-back
 * there is no way to answer "did that post go out?" after an interrupted
 * publish, so exactly-once is unachievable and an ambiguous publish goes to
 * NEEDS_REVIEW instead of being retried. That path was built for exactly this
 * case; LinkedIn is the connector that makes it real.
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
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: false,
  draftSupport: false,
  editPost: false,
  deletePost: true,
  /** No read-back on the self-serve tier: needs r_member_social. */
  retrievePosts: false,
  /** Needs r_member_social, which is not self-serve. */
  comments: false,
  replies: false,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  /** Member post analytics need r_member_social. */
  analytics: false,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: false,
  webhooks: false,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: true,
} as const satisfies ProviderCapabilities

/**
 * 150 requests per member per day. That is the number that binds.
 *
 * LinkedIn throttles at two levels — 150 per member and 100,000 per
 * application, both on a UTC day. Only the member limit is expressed here, and
 * deliberately: the app ceiling is not reached until roughly 666 connected
 * members, so a deployment hits the per-member wall first every time, and
 * declaring the larger number would describe a limit nobody meets.
 *
 * The budget is set below 150 because a single post is not a single request. A
 * nine-image share is one register plus one upload per image plus the share
 * itself — nineteen requests for one post — so the headroom is real rather
 * than cautious.
 *
 * [V] Member 150 / application 100,000 requests per UTC day, retrieved
 * 2026-08-31 —
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 */
export const limits = {
  publish: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  mediaUpload: { cost: 1, window: '24h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '24h', budget: 50, unit: 'requests' },
  // Per MEMBER, not per app — see above.
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '1h' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'video/mp4'],
    maxCount: 9,
    maxBytes: 10 * MB,
    durationSec: { min: 3, max: 600 },
  },
}

export const text: TextProfiles = {
  feed: {
    maxLength: 3000,
    maxHashtags: null,
    maxMentions: null,
    linkHandling: 'counted',
  },
}
