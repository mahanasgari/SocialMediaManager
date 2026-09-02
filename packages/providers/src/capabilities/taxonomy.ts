/**
 * The capability taxonomy.
 *
 * THIS FILE MUST HAVE ZERO DEPENDENCIES. It is imported by the browser so the
 * composer validates with the same code the server runs — one definition of
 * every platform rule, no client/server drift. An ESLint boundary enforces it.
 */

export const CAPABILITY_KEYS = [
  // Publishing
  'textPost',
  'imagePost',
  'videoPost',
  'carousel',
  'linkPost',
  'thread',
  'story',
  'reel',
  'shortVideo',
  'livePost',
  'firstComment',

  // Post lifecycle
  'draftSupport',
  'editPost',
  'deletePost',
  /**
   * Read-back of recently published posts.
   *
   * Special: this is what makes exactly-once publishing possible. After a lost
   * response, a provider WITHOUT this cannot be reconciled — we cannot tell
   * whether the post landed — so its variants go to NEEDS_REVIEW rather than
   * being retried. At-most-once plus a human prompt beats at-least-once plus a
   * duplicate public post, which is unrecoverable.
   */
  'retrievePosts',

  // Engagement
  'comments',
  'replies',
  'mentions',
  'dm',
  'conversations',
  'reactions',

  // Analytics
  'analytics',
  'audienceAnalytics',
  'followerMetrics',
  'contentMetrics',

  // Infrastructure
  'webhooks',
  'multiAccount',
  'pageDiscovery',
  'revokeToken',
] as const

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/**
 * Every key required, no partials.
 *
 * Adding a key here breaks compilation across every provider until each one
 * declares a position on it. That is the desired behaviour: a silently-defaulted
 * `false` on a provider that actually supports the feature is a permanently
 * invisible gap, and a silently-defaulted `true` is a dead button in the UI.
 */
export type ProviderCapabilities = Record<CapabilityKey, boolean>

/**
 * A publishing surface.
 *
 * Constraints are keyed by SURFACE, not by provider. Instagram feed images and
 * Instagram Reels have incompatible rules — JPEG at 4:5–1.91:1 versus MOV/MP4
 * at 0.01:1–10:1 with codec and container requirements. A provider-keyed profile
 * would encode the feed rules and reject every valid Reel.
 */
export const SURFACES = [
  'feed',
  'feedImage',
  'feedVideo',
  'carousel',
  'reel',
  'story',
  'short',
  'article',
  'thread',
  'pin',
] as const

export type Surface = (typeof SURFACES)[number]

export type ProviderId =
  | 'facebook'
  | 'instagram'
  | 'instagramLogin'
  | 'threads'
  | 'x'
  | 'linkedin'
  | 'linkedinPage'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'reddit'
  | 'telegram'
  | 'whatsapp'
  | 'googleBusiness'
  | 'snapchat'
  | 'mastodon'
  | 'bluesky'
  | 'discord'
  | 'slack'
  | 'tumblr'
  | 'medium'
  | 'wordpress'
  | 'blogger'
  | 'vk'
  | 'wechat'
  | 'mock'

/**
 * How honest we are being about a provider.
 *
 * Nothing unsupported is ever faked. A `skeleton` provider is visible in the
 * connect UI but disabled with the reason stated — never hidden, and never
 * pretending to work.
 */
export type ProviderState = 'implemented' | 'skeleton' | 'mock'
