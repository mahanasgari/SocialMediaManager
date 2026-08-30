import type { ProviderCapabilities } from '../capabilities/index.js'
import { MB, type MediaProfiles, type TextProfiles } from '../capabilities/index.js'
import type { ProviderLimits } from '../limits.js'

/**
 * Telegram — the Phase 6 inbox anchor.
 *
 * Chosen because it forces the inbox design to survive a provider whose model
 * does NOT match ours, which is the whole point of an anchor. Specifically:
 *
 *   - There is no "post" in the sense the composer means. Publishing is sending
 *     a message to a chat, and the chat is the audience. `providerAccountId` is
 *     a bot; the channel is a target.
 *   - Both webhook AND long-poll delivery exist, and they are mutually
 *     exclusive — calling getUpdates while a webhook is set is an error. A
 *     self-hoster with no public URL needs the poll path, so both must work
 *     through one write path (per §4.4) rather than two.
 *   - update_id is a monotonically increasing cursor, not an opaque token, and
 *     acknowledging it is what advances the queue. Getting this wrong replays
 *     every message forever or silently drops them.
 *
 * [V] Bot API getUpdates / setWebhook semantics and mutual exclusivity
 *     https://core.telegram.org/bots/api#getupdates
 *     retrieved 2026-08-30
 */
export const capabilities = {
  textPost: true,
  imagePost: true,
  videoPost: true,
  /** sendMediaGroup, capped at 10 items. */
  carousel: true,
  linkPost: true,
  /** reply_to_message_id chains messages into a thread. */
  thread: true,
  story: false,
  reel: false,
  shortVideo: false,
  livePost: false,
  firstComment: true,
  draftSupport: false,
  /**
   * editMessageText exists, but ONLY within 48 hours and only for messages the
   * bot itself sent.
   * [V] https://core.telegram.org/bots/api#editmessagetext retrieved 2026-08-30
   */
  editPost: true,
  deletePost: true,
  /**
   * FALSE, and this one is load-bearing. A bot cannot read back its own sent
   * messages — there is no "list my messages" method. Reconciliation after a
   * lost response is therefore impossible, and per §3.4 a stale IN_FLIGHT here
   * goes to NEEDS_REVIEW rather than being retried. This is exactly the
   * degradation path the anchor exists to exercise.
   */
  retrievePosts: false,
  /**
   * FALSE, and this is the anchor's most useful finding.
   *
   * Telegram has comments — a channel post's discussion thread — but a bot
   * CANNOT enumerate them. There is no "list replies to this message" method;
   * they arrive as updates in the linked discussion group or they are not
   * observed at all. So the concept exists while retrieval does not.
   *
   * The mock had conflated these, because in a simulator "supports comments"
   * naturally implies "can fetch comments". Splitting them is the correction:
   * `comments` means the inbox can RETRIEVE on demand, `replies` means we can
   * respond to something already delivered. Telegram is the second without the
   * first, and any provider that is push-only will be the same.
   */
  comments: false,
  replies: true,
  mentions: true,
  dm: true,
  conversations: true,
  reactions: true,
  /**
   * Only for channels the bot administers, and only a view count per message.
   * No impressions, no reach, no demographics.
   */
  analytics: true,
  audienceAnalytics: false,
  followerMetrics: true,
  contentMetrics: true,
  webhooks: true,
  multiAccount: true,
  pageDiscovery: false,
  revokeToken: false,
} as const satisfies ProviderCapabilities

/**
 * [V] ~30 messages/second overall, and 20 messages/minute to any single group.
 *     https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
 *     retrieved 2026-08-30
 *
 * Budgeted far below both. The documented numbers are the point at which
 * Telegram starts returning 429s, not a target to aim at, and the per-group
 * limit is the one a scheduler realistically hits.
 */
export const limits = {
  publish: { cost: 1, window: '1m', budget: 15, unit: 'requests' },
  mediaUpload: { cost: 1, window: '1m', budget: 15, unit: 'requests' },
  read: { cost: 1, window: '1m', budget: 60, unit: 'requests' },
  analytics: { cost: 1, window: '1m', budget: 30, unit: 'requests' },
  /** Per bot token, not per chat — the limit follows the bot. */
  scope: 'account',
  concurrency: { perAccount: 1, perProvider: 8 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '5m' },
} as const satisfies ProviderLimits

export const media: MediaProfiles = {
  feed: {
    mime: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
    maxCount: 10,
    /**
     * [V] 10 MB for photos, 50 MB for other files sent by URL or upload.
     *     https://core.telegram.org/bots/api#sending-files retrieved 2026-08-30
     *
     * The lower bound is used because the composer cannot know which branch the
     * file will take, and rejecting at 10 MB with a clear message beats a
     * provider error at publish time.
     */
    maxBytes: 10 * MB,
    aspect: { min: 0.05, max: 20 },
  },
}

export const text: TextProfiles = {
  feed: {
    /**
     * [V] 4096 characters for a message, but 1024 for a media CAPTION.
     *     https://core.telegram.org/bots/api#sendmessage
     *     retrieved 2026-08-30
     *
     *     The caption limit is the one that bites, because a post with an image
     *     is the common case. Surfaced via maxLengthWithMedia at compose time
     *     rather than discovered at publish time.
     */
    maxLength: 4096,
    maxLengthWithMedia: 1024,
    /** Links are not shortened and cost their literal length. */
    linkHandling: 'counted',
    maxHashtags: null,
    maxMentions: null,
  },
}
