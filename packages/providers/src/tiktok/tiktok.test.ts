import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TikTokProvider, tiktokTitle } from './adapter.js'
import * as registry from '../registry.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const tiktok = new TikTokProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: 'open-id-1',
  handle: '@northwind',
  displayName: 'Northwind',
  platformMeta: { openId: 'open-id-1' },
}
const CREDENTIAL: Credential = { accessToken: 'tok', refreshToken: 'ref', scopes: [] }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'short',
  text: 'A clip',
  media: [{ url: 'https://cdn.test/v.mp4', mime: 'video/mp4' }],
  idempotencyKey: 'k1',
  ...over,
})

function stub(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
    const next = responses[i++] ?? {}
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  return calls
}

/** creator_info answering with the given privacy options. */
const creatorInfo = (options: string[]) => ({
  body: { data: { privacy_level_options: options, creator_nickname: 'Northwind' } },
})

beforeEach(() => {
  process.env['TIKTOK_CLIENT_KEY'] = 'tt-key'
  process.env['TIKTOK_CLIENT_SECRET'] = 'tt-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['TIKTOK_CLIENT_KEY']
  delete process.env['TIKTOK_CLIENT_SECRET']
})

describe('the audit gate', () => {
  it('REFUSES to publish when the app is only offered SELF_ONLY', async () => {
    // The whole point of this connector. An unaudited app publishes
    // successfully and the video reaches nobody — no error, no signal, a month
    // of scheduled content quietly wasted. A refusal a person can act on beats
    // a success they cannot see.
    stub([creatorInfo(['SELF_ONLY'])])

    await expect(tiktok.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toThrow(
      /has not passed TikTok’s audit/
    )
  })

  it('names the audit as the cause, not a generic permission error', async () => {
    stub([creatorInfo(['SELF_ONLY'])])
    const error = await tiktok.publish(ACCOUNT, CREDENTIAL, payload()).catch((e) => e)

    expect(error.code).toBe('PermissionRevoked')
    // Someone reading this needs to know what to do, and "permission denied"
    // sends them hunting through scopes.
    expect(error.message).toMatch(/nobody but you can see/)
  })

  it('publishes when the audit has passed and public is on offer', async () => {
    const calls = stub([
      creatorInfo(['PUBLIC_TO_EVERYONE', 'SELF_ONLY']),
      { body: { data: { publish_id: 'pub-1' } } },
    ])

    const result = await tiktok.publish(ACCOUNT, CREDENTIAL, payload())

    expect(calls[0]!.url).toContain('/creator_info/query/')
    expect(calls[1]!.url).toContain('/post/publish/video/init/')
    expect(result.remoteId).toBe('pub-1')
  })

  it('reports the available options when a specific level is not permitted', async () => {
    stub([creatorInfo(['PUBLIC_TO_EVERYONE'])])

    await expect(
      tiktok.publish(ACCOUNT, CREDENTIAL, payload({ platformOptions: { privacyLevel: 'SELF_ONLY' } }))
    ).rejects.toThrow(/Available: PUBLIC_TO_EVERYONE/)
  })

  it('carries the caveat on the descriptor as well, for anyone about to connect', () => {
    const descriptor = registry.describe(tiktok)
    expect(descriptor.notice).toMatch(/audit/i)
    expect(descriptor.notice).toMatch(/verified/i)
    // It works — it is not disabled.
    expect(descriptor.disabledReason).toBeNull()
  })
})

describe('publishing', () => {
  it('sends PULL_FROM_URL, because TikTok fetches the file', async () => {
    const calls = stub([
      creatorInfo(['PUBLIC_TO_EVERYONE']),
      { body: { data: { publish_id: 'p' } } },
    ])
    await tiktok.publish(ACCOUNT, CREDENTIAL, payload())

    const body = JSON.parse(calls[1]!.body as string) as {
      source_info: { source: string; video_url: string }
    }
    expect(body.source_info.source).toBe('PULL_FROM_URL')
    expect(body.source_info.video_url).toBe('https://cdn.test/v.mp4')
  })

  it('returns the PUBLISH id and marks it pending, because there is no video yet', async () => {
    stub([creatorInfo(['PUBLIC_TO_EVERYONE']), { body: { data: { publish_id: 'pub-9' } } }])
    const result = await tiktok.publish(ACCOUNT, CREDENTIAL, payload())

    expect(result.remoteId).toBe('pub-9')
    expect(result.pending).toBe(true)
  })

  it('treats a missing publish id as ambiguous rather than as success', async () => {
    stub([creatorInfo(['PUBLIC_TO_EVERYONE']), { body: { data: {} } }])
    await expect(tiktok.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ProviderDown',
    })
  })

  it('refuses a post with no video', () => {
    const issues = tiktok.validate({ surface: 'short', text: 'words', media: [] })
    expect(issues.some((i) => i.code === 'media_required')).toBe(true)
  })
})

describe('error handling', () => {
  it('reads an error inside a 200 response, which TikTok does return', async () => {
    // Checking only the status code would treat every failure as success — and
    // for a publish, that means reporting a video that does not exist.
    stub([{ status: 200, body: { error: { code: 'invalid_param', message: 'bad title' } } }])

    await expect(tiktok.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ContentRejected',
    })
  })

  it('accepts an error object whose code is literally "ok"', async () => {
    // TikTok sends error.code = "ok" on success. Treating any present error
    // object as a failure would reject every successful call.
    stub([
      { body: { error: { code: 'ok' }, data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } } },
      { body: { error: { code: 'ok' }, data: { publish_id: 'p1' } } },
    ])

    const result = await tiktok.publish(ACCOUNT, CREDENTIAL, payload())
    expect(result.remoteId).toBe('p1')
  })

  it('explains an unverified domain, because the fix is outside this app', async () => {
    stub([{ body: { error: { code: 'url_ownership_unverified', message: 'nope' } } }])
    const error = await tiktok.publish(ACCOUNT, CREDENTIAL, payload()).catch((e) => e)

    expect(error.message).toMatch(/Verify the domain in your TikTok developer console/)
  })

  it('maps a dead token to reconnection', async () => {
    stub([{ body: { error: { code: 'access_token_invalid', message: 'expired' } } }])
    await expect(tiktok.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'TokenExpired',
    })
  })
})

describe('authorization', () => {
  it('sends client_key, which is what TikTok calls it', async () => {
    // The only provider here that does not call it client_id, and the error for
    // getting it wrong is an unhelpful redirect.
    const redirect = await tiktok.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    const params = new URL(redirect.url).searchParams

    expect(params.get('client_key')).toBe('tt-key')
    expect(params.get('client_id')).toBeNull()
  })

  it('refuses when unconfigured', async () => {
    delete process.env['TIKTOK_CLIENT_KEY']
    await expect(
      tiktok.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/TIKTOK_CLIENT_KEY/)
  })
})

describe('reading back', () => {
  it('reads create_time as SECONDS, not milliseconds', async () => {
    // Treating it as milliseconds puts every post in 1970 and the reconciler
    // matches nothing — which, for an ambiguous publish, means a duplicate.
    stub([
      {
        body: {
          data: {
            videos: [
              { id: 'v1', create_time: 1_788_000_000, video_description: 'recent' },
            ],
          },
        },
      },
    ])

    const posts = await tiktok.retrievePosts!(ACCOUNT, CREDENTIAL, new Date('2026-08-01'))
    expect(posts[0]!.createdAt.getUTCFullYear()).toBe(2026)
  })

  it('reports an absent metric as null', async () => {
    stub([{ body: { data: { videos: [{ view_count: 900 }] } } }])
    const metrics = await tiktok.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'v1')

    expect(metrics['views']).toBe(900)
    expect(metrics['shares']).toBeNull()
  })
})

describe('captions', () => {
  it('takes the first line', () => {
    expect(tiktokTitle('Look at this\nand more')).toBe('Look at this')
  })

  it('caps at 2200 characters', () => {
    expect(tiktokTitle('x'.repeat(3000))).toHaveLength(2200)
  })
})
