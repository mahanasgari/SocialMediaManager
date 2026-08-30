import type { AnyProvider } from './base.js'
import type { ProviderId } from './capabilities/index.js'
import { MockProvider } from './mock/mock.provider.js'
import { BlueskyProvider } from './bluesky/adapter.js'
import { TelegramProvider } from './telegram/adapter.js'
import { MastodonProvider } from './mastodon/adapter.js'
import { FacebookProvider } from './facebook/adapter.js'
import { InstagramProvider } from './instagram/adapter.js'
import { ThreadsProvider } from './threads/adapter.js'
import { XProvider } from './x/adapter.js'
import { LinkedInProvider } from './linkedin/adapter.js'
import { LinkedInPageProvider } from './linkedinPage/adapter.js'
import { TikTokProvider } from './tiktok/adapter.js'
import { YouTubeProvider } from './youtube/adapter.js'
import { PinterestProvider } from './pinterest/adapter.js'
import { RedditProvider } from './reddit/adapter.js'
import { WhatsAppProvider } from './whatsapp/adapter.js'
import { GoogleBusinessProvider } from './googleBusiness/adapter.js'
import { SnapchatProvider } from './snapchat/adapter.js'
import { DiscordProvider } from './discord/adapter.js'
import { SlackProvider } from './slack/adapter.js'
import { TumblrProvider } from './tumblr/adapter.js'
import { MediumProvider } from './medium/adapter.js'
import { WordPressProvider } from './wordpress/adapter.js'
import { BloggerProvider } from './blogger/adapter.js'
import { VKProvider } from './vk/adapter.js'
import { WeChatProvider } from './wechat/adapter.js'

/**
 * The provider registry.
 *
 * Adding provider twenty-four is one directory and one line here. If it requires
 * touching anything else, the abstraction has leaked.
 */
const providers = new Map<ProviderId, AnyProvider>()

export function register(provider: AnyProvider): void {
  providers.set(provider.id, provider)
}

export function get(id: ProviderId): AnyProvider | undefined {
  return providers.get(id)
}

export function require_(id: ProviderId): AnyProvider {
  const provider = providers.get(id)
  if (!provider) throw new Error(`No provider registered for "${id}".`)
  return provider
}

export function all(): AnyProvider[] {
  return [...providers.values()]
}

/**
 * What the API serves at GET /api/v1/social-providers, and the ONLY thing the
 * UI renders controls from.
 *
 * `configured` is separate from `state` on purpose: an implemented provider the
 * operator has not given credentials for is disabled for a different reason than
 * one that is not built yet, and the person looking at the screen needs to know
 * which — one they can fix, one they cannot.
 */
export type ProviderDescriptor = {
  id: ProviderId
  label: string
  state: 'implemented' | 'skeleton' | 'mock'
  configured: boolean
  capabilities: Record<string, boolean>
  surfaces: string[]
  disabledReason: string | null
  /** 'oauth' | 'credentials' — decides which connect control the UI renders. */
  authStyle: string
  /** Values to collect before connecting. Empty when none are needed. */
  connectFields: ReadonlyArray<{
    name: string
    label: string
    type: string
    hint?: string
    placeholder?: string
  }>
}

export function describe(provider: AnyProvider): ProviderDescriptor {
  const configured = provider.isConfigured()

  let disabledReason: string | null = null
  if (provider.state === 'skeleton') {
    disabledReason =
      (provider as { blockedReason?: string }).blockedReason ??
      'This connector is not implemented yet.'
  } else if (!configured) {
    disabledReason = 'Not configured by your administrator.'
  }

  return {
    id: provider.id,
    label: provider.label,
    state: provider.state,
    configured,
    capabilities: { ...provider.capabilities },
    surfaces: Object.keys(provider.media),
    disabledReason,
    authStyle: provider.authStyle ?? 'oauth',
    connectFields: provider.connectFields ?? [],
  }
}

export function reset(): void {
  providers.clear()
}

/** Registered by default so demo mode and tests always have one provider. */
register(new MockProvider())

// Bluesky needs no operator credentials — each account supplies its own app
// password — so it is always available rather than gated on configuration.
register(new BlueskyProvider(process.env['BLUESKY_SERVICE_URL'] || undefined))

// Telegram likewise: the bot token IS the credential, supplied per account.
// Note that inbound delivery still requires TELEGRAM_WEBHOOK_SECRET — the
// connector is usable for publishing without it, and the inbox simply receives
// nothing until it is set, which is the honest failure rather than an endpoint
// that accepts unsigned events.
register(new TelegramProvider())

// Mastodon registers its app PER INSTANCE at connect time, so like the two
// above it needs nothing from an operator to be usable.
register(new MastodonProvider())

// The documented-but-unimplemented roster.
//
// Registered rather than omitted, deliberately. A skeleton appears in the
// connect UI DISABLED with its reason shown, which tells an operator what the
// product covers and what stands between them and using it. Omitting them would
// make the roster look smaller than it is and give someone no way to find out
// that, say, TikTok needs an audit before anything they publish is visible.
register(new FacebookProvider())
register(new InstagramProvider())
register(new ThreadsProvider())
register(new XProvider())
register(new LinkedInProvider())
register(new LinkedInPageProvider())
register(new TikTokProvider())
register(new YouTubeProvider())
register(new PinterestProvider())
register(new RedditProvider())
register(new WhatsAppProvider())
register(new GoogleBusinessProvider())
register(new SnapchatProvider())
register(new DiscordProvider())
register(new SlackProvider())
register(new TumblrProvider())
register(new MediumProvider())
register(new WordPressProvider())
register(new BloggerProvider())
register(new VKProvider())
register(new WeChatProvider())
