import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedInProvider } from './adapter.js'
import { capabilities, limits } from './capabilities.js'
import * as registry from '../registry.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const linkedin = new LinkedInProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: '782bbtaQ',
  handle: 'Ada Lovelace',
  displayName: 'Ada Lovelace',
  platformMeta: { authorUrn: 'urn:li:person:782bbtaQ' },
}
const CREDENTIAL: Credential = { accessToken: 'tok', scopes: [] }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'feed',
  text: 'Thoughts on distributed systems.',
  media: [],
  idempotencyKey: 'k1',
  ...over,
})

function stub(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>
) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> =
    []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const next = responses[i++] ?? {}
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  })

  return calls
}

beforeEach(() => {
  process.env['LINKEDIN_CLIENT_ID'] = 'li-id'
  process.env['LINKEDIN_CLIENT_SECRET'] = 'li-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['LINKEDIN_CLIENT_ID']
  delete process.env['LINKEDIN_CLIENT_SECRET']
})

describe('what the self-serve tier can actually do', () => {
  it('declares NO read-back, because w_member_social does not grant one', () => {
    // Not an unimplemented method — a permission the self-serve tier does not
    // include. Reading a member's own posts needs r_member_social.
    expect(capabilities.retrievePosts).toBe(false)
  })

  it('declares no comments, reactions or post analytics either', () => {
    // Declaring these true would put an inbox that never fills and metrics that
    // stay empty in front of someone who would reasonably conclude the product
    // is broken.
    expect(capabilities.comments).toBe(false)
    expect(capabilities.reactions).toBe(false)
    expect(capabilities.analytics).toBe(false)
  })

  it('says plainly that an interrupted publish will be held, not retried', () => {
    // The consequence of no read-back reaches the pipeline, not just the UI:
    // exactly-once is unachievable, so an ambiguous publish goes to
    // NEEDS_REVIEW. Someone scheduling against LinkedIn should know that first.
    const descriptor = registry.describe(linkedin)
    expect(descriptor.notice).toMatch(/cannot read your posts back/i)
    expect(descriptor.notice).toMatch(/could post twice/i)
  })

  it('budgets against the per-member limit, which is the one that binds', () => {
    // 150 per member per day against 100,000 per app: the app ceiling needs
    // ~666 connected members before it is reached, so a deployment hits the
    // member wall every time.
    expect(limits.scope).toBe('account')
    expect(limits.publish.budget).toBeLessThan(150)
  })
})

describe('authorization', () => {
  it('joins scopes with SPACES, not commas', () => {
    // LinkedIn silently drops a comma-joined list and the token comes back with
    // no permissions at all — which fails later, at publish, looking like a
    // permission problem on the account.
    return linkedin.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' }).then((r) => {
      const scope = new URL(r.url).searchParams.get('scope')!
      expect(scope).toBe('openid profile w_member_social')
      expect(scope).not.toContain(',')
    })
  })

  it('does not ask for an email address it has no use for', async () => {
    const redirect = await linkedin.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    expect(new URL(redirect.url).searchParams.get('scope')).not.toContain('email')
  })

  it('refuses to build a URL when unconfigured', async () => {
    delete process.env['LINKEDIN_CLIENT_ID']
    await expect(
      linkedin.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/LINKEDIN_CLIENT_ID/)
  })

  it('says reconnect rather than pretending to refresh', async () => {
    // A self-serve app gets no refresh token. A silent no-op here would leave
    // the account looking healthy while it quietly stopped working.
    await expect(linkedin.refreshToken(CREDENTIAL)).rejects.toThrow(/Reconnect this account/)
  })
})

describe('connecting', () => {
  it('builds the author URN from the OIDC subject', async () => {
    stub([
      { body: { access_token: 'at', expires_in: 5_184_000 } },
      { body: { sub: '782bbtaQ', name: 'Ada Lovelace' } },
    ])

    const accounts = await linkedin.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )

    expect(accounts[0]!.providerAccountId).toBe('782bbtaQ')
    // Stored built, so the one place the URN shape is decided is at connect.
    expect((accounts[0]!.platformMeta as { authorUrn: string }).authorUrn).toBe(
      'urn:li:person:782bbtaQ'
    )
  })

  it('falls back to given and family name when `name` is absent', async () => {
    stub([
      { body: { access_token: 'at' } },
      { body: { sub: 'x1', given_name: 'Ada', family_name: 'Lovelace' } },
    ])

    const accounts = await linkedin.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )
    expect(accounts[0]!.displayName).toBe('Ada Lovelace')
  })

  it('names the missing product when no member id comes back', async () => {
    stub([{ body: { access_token: 'at' } }, { body: {} }])
    await expect(
      linkedin.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })
    ).rejects.toThrow(/OpenID Connect/)
  })
})

describe('publishing', () => {
  it('reads the post id from the X-RestLi-Id HEADER, not the body', async () => {
    // A 201 comes back with an empty body. A connector that parses the body
    // concludes the publish failed while the post is live — which is exactly
    // how a retry becomes a duplicate.
    stub([{ status: 201, body: {}, headers: { 'x-restli-id': 'urn:li:share:7' } }])

    const result = await linkedin.publish(ACCOUNT, CREDENTIAL, payload())
    expect(result.remoteId).toBe('urn:li:share:7')
    expect(result.remoteUrl).toContain('urn:li:share:7')
  })

  it('treats a missing id header as ambiguous rather than as success', async () => {
    stub([{ status: 201, body: {} }])
    await expect(linkedin.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ProviderDown',
    })
  })

  it('sends the protocol version header on every call', async () => {
    // Without it LinkedIn answers with a protocol error that names nothing
    // useful.
    const calls = stub([{ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }])
    await linkedin.publish(ACCOUNT, CREDENTIAL, payload())
    expect(calls[0]!.headers['x-restli-protocol-version']).toBe('2.0.0')
  })

  it('posts plain text as shareMediaCategory NONE', async () => {
    const calls = stub([{ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }])
    await linkedin.publish(ACCOUNT, CREDENTIAL, payload({ text: 'No links here.' }))

    const body = JSON.parse(calls[0]!.body as string)
    const content = body.specificContent['com.linkedin.ugc.ShareContent']
    expect(content.shareMediaCategory).toBe('NONE')
    expect(content.media).toBeUndefined()
  })

  it('turns a link into an ARTICLE share', async () => {
    const calls = stub([{ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }])
    await linkedin.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ text: 'Worth reading: https://example.com/post. Really.' })
    )

    const content = JSON.parse(calls[0]!.body as string).specificContent[
      'com.linkedin.ugc.ShareContent'
    ]
    expect(content.shareMediaCategory).toBe('ARTICLE')
    // Trailing punctuation is not part of the URL, and LinkedIn will happily
    // build a card for a link that 404s.
    expect(content.media[0].originalUrl).toBe('https://example.com/post')
  })

  it('registers, uploads and references each image in turn', async () => {
    const calls = stub([
      {
        body: {
          value: {
            asset: 'urn:li:digitalmediaAsset:A1',
            uploadMechanism: {
              'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
                uploadUrl: 'https://upload.test/a1',
              },
            },
          },
        },
      },
      { body: {} }, // reading our own storage
      { body: {} }, // the upload
      { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } },
    ])

    const result = await linkedin.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ media: [{ url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }] })
    )

    expect(calls[0]!.url).toContain('/v2/assets?action=registerUpload')
    expect(calls[2]!.url).toBe('https://upload.test/a1')

    const content = JSON.parse(calls[3]!.body as string).specificContent[
      'com.linkedin.ugc.ShareContent'
    ]
    expect(content.shareMediaCategory).toBe('IMAGE')
    expect(content.media[0].media).toBe('urn:li:digitalmediaAsset:A1')
    expect(result.remoteId).toBe('urn:li:share:9')
  })

  it('uses the video recipe for a video', async () => {
    const calls = stub([
      {
        body: {
          value: {
            asset: 'urn:li:digitalmediaAsset:V1',
            uploadMechanism: {
              'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
                uploadUrl: 'https://upload.test/v1',
              },
            },
          },
        },
      },
      { body: {} },
      { body: {} },
      { status: 201, headers: { 'x-restli-id': 'urn:li:share:10' } },
    ])

    await linkedin.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ media: [{ url: 'https://cdn.test/v.mp4', mime: 'video/mp4' }] })
    )

    const register = JSON.parse(calls[0]!.body as string)
    expect(register.registerUploadRequest.recipes[0]).toBe(
      'urn:li:digitalmediaRecipe:feedshare-video'
    )
  })

  it('fails clearly when LinkedIn returns no upload URL', async () => {
    stub([{ body: { value: {} } }])
    await expect(
      linkedin.publish(
        ACCOUNT,
        CREDENTIAL,
        payload({ media: [{ url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }] })
      )
    ).rejects.toThrow(/did not return an upload URL/i)
  })

  it('defaults to PUBLIC and honours a connections-only request', async () => {
    const first = stub([{ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }])
    await linkedin.publish(ACCOUNT, CREDENTIAL, payload())
    expect(
      JSON.parse(first[0]!.body as string).visibility['com.linkedin.ugc.MemberNetworkVisibility']
    ).toBe('PUBLIC')

    vi.unstubAllGlobals()
    const second = stub([{ status: 201, headers: { 'x-restli-id': 'urn:li:share:2' } }])
    await linkedin.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ platformOptions: { visibility: 'CONNECTIONS' } })
    )
    expect(
      JSON.parse(second[0]!.body as string).visibility['com.linkedin.ugc.MemberNetworkVisibility']
    ).toBe('CONNECTIONS')
  })
})

describe('deleting', () => {
  it('encodes the URN, which contains colons', async () => {
    const calls = stub([{ status: 204 }])
    await linkedin.deletePost!(ACCOUNT, CREDENTIAL, 'urn:li:ugcPost:123')

    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toContain(encodeURIComponent('urn:li:ugcPost:123'))
  })
})

describe('errors', () => {
  it('treats 401 as needing reconnection', async () => {
    stub([{ status: 401, body: { message: 'expired' } }])
    await expect(linkedin.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'TokenExpired',
    })
  })

  it('points a 403 at the missing product, which is the usual cause', async () => {
    stub([{ status: 403, body: { message: 'not authorized' } }])
    const error = await linkedin.publish(ACCOUNT, CREDENTIAL, payload()).catch((e) => e)

    expect(error.code).toBe('PermissionRevoked')
    expect(error.message).toMatch(/Share on LinkedIn product/)
  })

  it('describes a 429 as a DAILY limit, because that is what it is', async () => {
    // Not a burst. A short retry is pointless, so no Retry-After is invented.
    stub([{ status: 429, body: { message: 'throttled' } }])
    const error = await linkedin.publish(ACCOUNT, CREDENTIAL, payload()).catch((e) => e)

    expect(error.code).toBe('RateLimited')
    expect(error.message).toMatch(/daily limit/i)
    expect(error.options.retryAfterSeconds).toBeUndefined()
  })

  it('maps a LinkedIn-side fault to ProviderDown so it reconciles', async () => {
    stub([{ status: 502, body: { message: 'bad gateway' } }])
    await expect(linkedin.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ProviderDown',
    })
  })
})
