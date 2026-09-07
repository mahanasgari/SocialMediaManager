import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Instagram reached through Buffer — a third door to the same network.
 *
 * IMPLEMENTED. Needs a Buffer API key per workspace and an Instagram channel
 * already connected inside that Buffer account. It needs nothing from Meta: no
 * app, no App Review, no Business account of our own. That is the entire reason
 * this route exists, and for anyone who cannot spend six weeks in Meta's review
 * queue it is the difference between publishing and not.
 *
 * A THIRD provider rather than a flag on the other two, for the reason the
 * Instagram Login report already settled: the capability matrix is the one place
 * this product promises the truth, and a route that cannot do DMs, comments or
 * audience insights must SAY so in the matrix rather than branch on a token type
 * inside every method.
 *
 * What Buffer costs you, stated plainly because the UI will show it:
 *
 *   - NO ENGAGEMENT AT ALL. Buffer's API publishes and reports; it exposes no
 *     comments, replies, mentions or DMs. An account connected this way cannot
 *     feed the inbox, and the inbox will correctly show nothing rather than
 *     appearing broken.
 *   - NO DELETE, WHICH IS SUBTLER THAN IT LOOKS. Buffer has a deletePost
 *     mutation, so declaring `deletePost: true` would compile, pass, and be a
 *     lie: it removes BUFFER's record of the post, not the post on Instagram.
 *     A user clicking Delete would watch the row vanish while the post stayed
 *     public. False, and the method does not exist.
 *   - NO EDIT, FOR THE SAME REASON. `editPost` edits something Buffer has not
 *     sent yet. Once it is on Instagram, Buffer cannot change it either.
 *   - MEDIA MUST BE PUBLICLY REACHABLE. Buffer fetches assets by URL from its
 *     own servers, so a self-hosted install whose object storage is not exposed
 *     to the internet can publish text but not images.
 *     [V] https://developers.buffer.com/examples/create-image-post.html
 *         retrieved 2026-09-07
 *
 * Confidence is [A] unless a value carries a source URL and retrieval date.
 */
export const capabilities = {
  /** As on the direct connectors: the post carries text. Instagram has no text-only post. */
  textPost: true,
  imagePost: true,
  videoPost: true,
  /**
   * Buffer accepts an array of assets, and multiple images on Instagram would
   * be a carousel. Unverified through this route, so false — a capability that
   * turns out not to work is a dead button, and the cost of a missing one is
   * only that a user posts twice.
   */
  carousel: false,
  /** Instagram strips links from captions regardless of how the post arrives. */
  linkPost: false,
  thread: false,
  /** No surface selector in Buffer's post input; a video posts as a video. */
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  /** Buffer's product offers a first comment; its public API does not expose one. */
  firstComment: false,
  draftSupport: true,
  /** Edits reach a post Buffer has not sent. Once published, neither of us can. */
  editPost: false,
  /** See the header: Buffer's delete removes Buffer's record, not the Instagram post. */
  deletePost: false,
  /**
   * TRUE, and it is what makes this route safe to retry.
   *
   * Buffer's `posts` query reads back what it holds for a channel, so a publish
   * whose response was lost can be resolved by looking rather than guessed at.
   * Without it every timeout would have to go to NEEDS_REVIEW.
   */
  retrievePosts: true,
  comments: false,
  replies: false,
  mentions: false,
  dm: false,
  conversations: false,
  reactions: false,
  /** Buffer collects per-post metrics and exposes them on Post.metrics. */
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: false,
  contentMetrics: true,
  webhooks: false,
  multiAccount: true,
  /** One key lists every channel in the Buffer account, which is discovery. */
  pageDiscovery: true,
  /** A key is revoked in Buffer's own settings, not through the API. */
  revokeToken: false,
} as const satisfies ProviderCapabilities

export const limits = {
  /**
   * Buffer publishes no numeric rate limits in its public documentation, so
   * every budget here is [A] and deliberately low.
   *
   * Declared low rather than omitted: the gate requires a budget precisely so
   * that an unknown limit is treated as a small one instead of an absent one.
   * Buffer sits between us and Instagram, so Instagram's own ceiling still
   * applies underneath — spending ours faster than that would only move where
   * the refusal happens.
   */
  publish: { cost: 1, window: '24h', budget: 50, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1h', budget: 100, unit: 'requests' },
  read: { cost: 1, window: '1h', budget: 120, unit: 'requests' },
  analytics: { cost: 1, window: '1h', budget: 120, unit: 'requests' },
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits

/**
 * Instagram's own rules, because the network has not changed.
 *
 * Duplicated from the direct connectors rather than imported, on the same
 * reasoning stated there: if one route's constraints diverge later, the others
 * must not silently inherit the change.
 *
 * Only feedImage and feedVideo appear. Buffer's post input has no surface
 * selector, so there is no way to ask for a Reel or a Story through it — and a
 * surface we cannot target is one a composer must not offer.
 */
export const media: MediaProfiles = {
  feedImage: {
    // [V] https://developers.facebook.com/docs/instagram-platform/content-publishing
    //     retrieved 2026-09-02
    mime: ['image/jpeg'],
    maxCount: 1,
    maxBytes: 8 * MB,
    aspect: { min: 0.8, max: 1.91 },
  },
  feedVideo: {
    // [V] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
    //     retrieved 2026-08-29
    mime: ['video/mp4', 'video/quicktime'],
    maxCount: 1,
    maxBytes: 1024 * MB,
    aspect: { min: 0.01, max: 10 },
    durationSec: { min: 3, max: 900 },
  },
}

export const text: TextProfiles = {
  feedImage: { maxLength: 2200, maxHashtags: 30, maxMentions: null, linkHandling: 'stripped' },
  feedVideo: { maxLength: 2200, maxHashtags: 30, maxMentions: null, linkHandling: 'stripped' },
}
