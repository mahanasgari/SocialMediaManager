import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstagramLoginProvider } from './adapter.js'
import { capabilities } from './capabilities.js'
import { clearProviderSettings, setProviderSettings } from '../settings.js'
import { igAuthorizeUrl } from '../meta/instagram-login.js'
import { ProviderError } from '../errors.js'

/**
 * Instagram via Instagram Login.
 *
 * The tests worth having here are about the two things that distinguish this
 * connector from the Facebook Login one: the shape of the authorization
 * request, and the promises the capability matrix makes about DMs.
 */

const ACCOUNT = {
  id: 'a1',
  providerAccountId: '17841400000000000',
  handle: '@brand',
  displayName: 'Brand',
  platformMeta: {},
}

const CREDENTIAL = { accessToken: 'IGQV-long-lived', scopes: ['instagram_business_basic'] }

describe('the authorization request', () => {
  const provider = new InstagramLoginProvider()

  beforeEach(() => {
    clearProviderSettings()
    setProviderSettings({ INSTAGRAM_APP_ID: '1531617227440535', INSTAGRAM_APP_SECRET: 'shh' })
  })

  afterEach(() => clearProviderSettings())

  it('goes to Instagram, not to Facebook', async () => {
    // The entire point of this connector. Sending someone to facebook.com is
    // what forces the Page requirement this flow exists to remove.
    const { url } = await provider.getAuthUrl({
      redirectUri: 'https://app.example.com/api/v1/social-accounts/callback/instagramLogin',
      state: 'st',
    })
    const parsed = new URL(url)

    expect(parsed.host).toBe('www.instagram.com')
    expect(parsed.pathname).toBe('/oauth/authorize')
  })

  it('separates scopes with commas', async () => {
    // Meta accepts comma or URL-encoded space. A space-separated list arrives
    // as ONE unrecognised scope and the consent screen silently shows nothing,
    // which is a miserable thing to debug.
    const { url } = await provider.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 'st' })
    const scope = new URL(url).searchParams.get('scope') ?? ''

    expect(scope).toContain(',')
    expect(scope).not.toContain(' ')
    expect(scope.split(',')).toEqual([
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_insights',
    ])
  })

  it('does not ask for permissions it will not use', () => {
    // Requesting DM access this connector does not implement would be asking a
    // person to approve something that buys them nothing, and gives App Review
    // a fair reason to ask what we do with it.
    const url = igAuthorizeUrl({
      appId: 'a',
      redirectUri: 'https://x.test/cb',
      state: 's',
      scopes: ['instagram_business_basic'],
    })
    expect(url).not.toContain('manage_messages')
  })

  it('refuses to build a URL when the app credentials are missing, naming which ones', async () => {
    clearProviderSettings()
    // The Instagram app id is NOT the Meta one, and someone who pastes the
    // Facebook app id here gets a token-exchange failure that blames the code.
    // Saying so up front is the only place this is cheap to fix.
    await expect(
      provider.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/not the Facebook ones/i)
  })

  it('is unconfigured until BOTH halves are present', () => {
    clearProviderSettings()
    expect(provider.isConfigured()).toBe(false)

    setProviderSettings({ INSTAGRAM_APP_ID: 'id-only' })
    expect(provider.isConfigured()).toBe(false)

    setProviderSettings({ INSTAGRAM_APP_ID: 'id', INSTAGRAM_APP_SECRET: 'secret' })
    expect(provider.isConfigured()).toBe(true)
  })

  it('does not read the Meta app credentials', () => {
    // Two connectors to the same network with two different app registrations.
    // Silently falling back to the Facebook credentials would produce a
    // connector that looks configured and fails at the exchange.
    clearProviderSettings()
    setProviderSettings({ META_APP_ID: 'meta', META_APP_SECRET: 'meta-secret' })
    expect(provider.isConfigured()).toBe(false)
  })
})

describe('what the callback rejects', () => {
  const provider = new InstagramLoginProvider()

  beforeEach(() => {
    setProviderSettings({ INSTAGRAM_APP_ID: 'id', INSTAGRAM_APP_SECRET: 'secret' })
  })
  afterEach(() => {
    clearProviderSettings()
    vi.unstubAllGlobals()
  })

  it('reports a cancelled authorization in Instagram’s words, not ours', async () => {
    // Pressing Cancel is not a bug and not our failure. Reporting it as
    // "no authorization code" would send someone looking for a fault.
    await expect(
      provider.handleCallback(
        { redirectUri: 'https://x.test/cb', state: 's' },
        { error: 'access_denied', error_description: 'The user denied your request.' }
      )
    ).rejects.toThrow('The user denied your request.')
  })

  it('rejects a callback carrying neither a code nor an error', async () => {
    await expect(
      provider.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, {})
    ).rejects.toThrow(/authorization code/i)
  })
})

describe('capability honesty', () => {
  const provider = new InstagramLoginProvider()

  it('declares dm false AND exposes no sendMessage', () => {
    // The bidirectional half of the contract, stated here because this is the
    // one capability that differs from the Facebook Login connector. A method
    // present behind a false flag is how a dead button reaches the composer.
    expect(capabilities.dm).toBe(false)
    expect((provider as unknown as { sendMessage?: unknown }).sendMessage).toBeUndefined()
  })

  it('says on the connector itself why DMs are missing and what to use instead', () => {
    // "Not supported" without a route forward is a dead end. The notice is what
    // the accounts page renders before someone connects.
    expect(provider.notice).toMatch(/direct messages are not supported/i)
    expect(provider.notice).toMatch(/facebook pages/i)
  })

  it('warns that App Review gates the permissions before anyone can connect', () => {
    // In development mode this works for test users and nobody else. A person
    // who ships it to customers and discovers that later has been misled by
    // silence.
    expect(provider.notice).toMatch(/app review/i)
  })

  it('claims retrievePosts, which is what makes reconciliation possible', () => {
    // Load-bearing: with a read-back, a lost response reconciles instead of
    // going to NEEDS_REVIEW. Declaring it true obliges the method to exist.
    expect(capabilities.retrievePosts).toBe(true)
    expect(typeof provider.retrievePosts).toBe('function')
  })
})

describe('publishing', () => {
  const provider = new InstagramLoginProvider()

  it('refuses a text-only post before any call is made', async () => {
    // Instagram has no text post. Failing here costs nothing; failing at the
    // provider costs a rate-limit token and a confusing error.
    await expect(
      provider.publish(ACCOUNT, CREDENTIAL, {
        surface: 'feedImage',
        text: 'hello',
        media: [],
        idempotencyKey: 'k',
      })
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('flags a text-only draft in the composer rather than at publish time', () => {
    const issues = provider.validate({
      surface: 'feedImage',
      text: 'hello',
      media: [],
    } as never)
    expect(issues.some((issue) => issue.code === 'media_required')).toBe(true)
  })
})
