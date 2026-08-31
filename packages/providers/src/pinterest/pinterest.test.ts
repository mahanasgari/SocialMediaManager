import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PinterestProvider } from './adapter.js'
import * as registry from '../registry.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const pinterest = new PinterestProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: 'northwind',
  handle: '@northwind',
  displayName: 'Northwind',
  platformMeta: { defaultBoardId: 'board-1' },
}
const CREDENTIAL: Credential = { accessToken: 'tok', refreshToken: 'ref', scopes: [] }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'pin',
  text: 'A lovely thing',
  media: [{ url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }],
  idempotencyKey: 'k1',
  ...over,
})

function stub(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; body: string | undefined; auth: string | undefined }> = []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      auth: headers['authorization'],
    })
    const next = responses[i++] ?? {}
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  })

  return calls
}

beforeEach(() => {
  process.env['PINTEREST_APP_ID'] = 'pin-app'
  process.env['PINTEREST_APP_SECRET'] = 'pin-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['PINTEREST_APP_ID']
  delete process.env['PINTEREST_APP_SECRET']
})

describe('the sandbox notice', () => {
  it('is surfaced on the descriptor, not buried in a comment', () => {
    // Trial access creates pins visible only to their creator. The API returns
    // success, an id comes back, and the pin reaches nobody — the worst failure
    // in this system, because it is indistinguishable from working. There is no
    // runtime signal to check, so it has to be said before anyone schedules.
    const descriptor = registry.describe(pinterest)
    expect(descriptor.notice).toMatch(/Trial access/i)
    expect(descriptor.notice).toMatch(/visible only to you/i)
  })

  it('is not a disabledReason, because the connector works', () => {
    const descriptor = registry.describe(pinterest)
    expect(descriptor.state).toBe('implemented')
    expect(descriptor.disabledReason).toBeNull()
  })

  it('a connector with no caveat has no notice', () => {
    // The field must stay meaningful: if every provider carried one, nobody
    // would read any of them.
    const mock = registry.all().find((p) => p.id === 'mock')!
    expect(registry.describe(mock).notice).toBeNull()
  })
})

describe('configuration', () => {
  it('is unconfigured without app credentials', () => {
    delete process.env['PINTEREST_APP_SECRET']
    expect(pinterest.isConfigured()).toBe(false)
  })

  it('refuses to build a broken authorize URL', async () => {
    delete process.env['PINTEREST_APP_ID']
    await expect(
      pinterest.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/PINTEREST_APP_ID/)
  })

  it('asks for write scope, since publishing is the point', async () => {
    const redirect = await pinterest.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    expect(new URL(redirect.url).searchParams.get('scope')).toContain('pins:write')
  })
})

describe('connecting', () => {
  it('reads the boards and remembers one as the default', async () => {
    stub([
      { body: { access_token: 'at', refresh_token: 'rt', expires_in: 2_592_000 } },
      { body: { username: 'northwind', account_type: 'BUSINESS' } },
      { body: { items: [{ id: 'b1', name: 'Recipes' }, { id: 'b2', name: 'Travel' }] } },
    ])

    const accounts = await pinterest.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )

    const meta = accounts[0]!.platformMeta as { boards: unknown[]; defaultBoardId: string }
    expect(meta.boards).toHaveLength(2)
    // Stored rather than hard-coded, so choosing another board later changes
    // data instead of code.
    expect(meta.defaultBoardId).toBe('b1')
    expect(accounts[0]!.credential.refreshToken).toBe('rt')
  })

  it('refuses an account with no boards AT CONNECT, not at publish', async () => {
    // A Pinterest account with no board cannot receive a pin. Finding that out
    // when a scheduled post fails is finding out too late.
    stub([
      { body: { access_token: 'at' } },
      { body: { username: 'n' } },
      { body: { items: [] } },
    ])

    await expect(
      pinterest.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })
    ).rejects.toThrow(/no boards/i)
  })

  it('sends the app credentials in a Basic header, never the body', async () => {
    // A secret in a form body is a secret in whatever logs that body on failure.
    const calls = stub([
      { body: { access_token: 'at' } },
      { body: { username: 'n' } },
      { body: { items: [{ id: 'b1', name: 'B' }] } },
    ])

    await pinterest.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })

    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('pin-app:pin-secret').toString('base64')}`)
    expect(calls[0]!.body).not.toContain('pin-secret')
  })
})

describe('publishing', () => {
  it('creates a pin on the default board', async () => {
    const calls = stub([{ body: { id: 'pin-1' } }])
    const result = await pinterest.publish(ACCOUNT, CREDENTIAL, payload())

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body['board_id']).toBe('board-1')
    expect(body['media_source']).toEqual({
      source_type: 'image_url',
      url: 'https://cdn.test/a.jpg',
    })
    expect(result.remoteId).toBe('pin-1')
    expect(result.remoteUrl).toBe('https://www.pinterest.com/pin/pin-1/')
  })

  it('lets a variant name a different board', async () => {
    const calls = stub([{ body: { id: 'pin-2' } }])
    await pinterest.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ platformOptions: { boardId: 'board-9' } })
    )
    expect(JSON.parse(calls[0]!.body!)['board_id']).toBe('board-9')
  })

  it('uses the first line as the title when none was given', async () => {
    // A pin with no title renders as a bare image, and the first line is what
    // people write anyway.
    const calls = stub([{ body: { id: 'p' } }])
    await pinterest.publish(ACCOUNT, CREDENTIAL, payload({ text: 'Roast chicken\nServes four.' }))
    expect(JSON.parse(calls[0]!.body!)['title']).toBe('Roast chicken')
  })

  it('says so when there is no board to publish to', async () => {
    await expect(
      pinterest.publish({ ...ACCOUNT, platformMeta: {} }, CREDENTIAL, payload())
    ).rejects.toThrow(/no default/i)
  })

  it('refuses a pin with no image', () => {
    const issues = pinterest.validate({ surface: 'pin', text: 'words only', media: [] })
    expect(issues.some((i) => i.code === 'media_required')).toBe(true)
  })
})

describe('tokens', () => {
  it('refreshes, because a Pinterest token expires in thirty days', async () => {
    // Unlike the Meta connectors there IS a refresh path here. An account left
    // unrefreshed for a month stops publishing, and the first sign is a failed
    // scheduled post.
    const calls = stub([{ body: { access_token: 'new', refresh_token: 'newref', expires_in: 100 } }])
    const set = await pinterest.refreshToken(CREDENTIAL)

    expect(new URLSearchParams(calls[0]!.body!).get('grant_type')).toBe('refresh_token')
    expect(set.accessToken).toBe('new')
    expect(set.expiresAt).toBeInstanceOf(Date)
  })

  it('says to reconnect when there is no refresh token stored', async () => {
    await expect(
      pinterest.refreshToken({ accessToken: 'a', scopes: [] })
    ).rejects.toThrow(/Reconnect/i)
  })
})

describe('errors', () => {
  it('treats 401 as needing reconnection', async () => {
    stub([{ status: 401, body: { message: 'expired' } }])
    await expect(pinterest.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'TokenExpired',
    })
  })

  it('honours Retry-After on a 429', async () => {
    stub([{ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '42' } }])
    await expect(pinterest.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'RateLimited',
      options: { retryAfterSeconds: 42 },
    })
  })

  it('maps a Pinterest-side fault to ProviderDown, so it reconciles', async () => {
    stub([{ status: 503, body: { message: 'unavailable' } }])
    await expect(pinterest.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ProviderDown',
    })
  })

  it('does not retry a request that is simply wrong', async () => {
    stub([{ status: 400, body: { message: 'board_id is invalid' } }])
    await expect(pinterest.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ContentRejected',
    })
  })
})

describe('reading back', () => {
  it('filters to the reconciliation window', async () => {
    stub([
      {
        body: {
          items: [
            { id: 'new', created_at: '2026-08-31T12:00:00Z', description: 'recent' },
            { id: 'old', created_at: '2026-01-01T12:00:00Z', description: 'ancient' },
          ],
        },
      },
    ])

    const posts = await pinterest.retrievePosts!(
      ACCOUNT,
      CREDENTIAL,
      new Date('2026-08-31T11:00:00Z')
    )
    expect(posts.map((p) => p.remoteId)).toEqual(['new'])
  })

  it('reports outbound clicks, which is the metric Pinterest is for', async () => {
    stub([{ body: { all: { lifetime_metrics: { IMPRESSION: 500, OUTBOUND_CLICK: 12 } } } }])
    const metrics = await pinterest.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'pin-1')

    expect(metrics['impressions']).toBe(500)
    expect(metrics['outboundClicks']).toBe(12)
    // Absent, not zero.
    expect(metrics['saves']).toBeNull()
  })
})
