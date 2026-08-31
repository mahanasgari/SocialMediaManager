import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FacebookProvider } from './adapter.js'
import { mapGraphError } from '../meta/graph.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const facebook = new FacebookProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: '1122334455',
  handle: 'Northwind',
  displayName: 'Northwind',
  platformMeta: {},
}
const CREDENTIAL: Credential = { accessToken: 'page-token', scopes: [] }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'feed',
  text: 'Hello',
  media: [],
  idempotencyKey: 'k1',
  ...over,
})

/** Captures the calls the adapter makes and answers each with a queued body. */
function stubGraph(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    })
    const body = responses[i++] ?? {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  return calls
}

beforeEach(() => {
  process.env['META_APP_ID'] = 'app-123'
  process.env['META_APP_SECRET'] = 'secret-abc'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['META_APP_ID']
  delete process.env['META_APP_SECRET']
})

describe('configuration', () => {
  it('is unconfigured without operator credentials', () => {
    delete process.env['META_APP_ID']
    expect(facebook.isConfigured()).toBe(false)
  })

  it('is configured once both app values are present', () => {
    expect(facebook.isConfigured()).toBe(true)
  })

  it('refuses to build an authorize URL when unconfigured, rather than a broken one', async () => {
    delete process.env['META_APP_SECRET']
    await expect(
      facebook.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/META_APP_ID and META_APP_SECRET/)
  })

  it('asks for exactly the scopes it uses', async () => {
    const redirect = await facebook.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's1' })
    const scopes = new URL(redirect.url).searchParams.get('scope')!.split(',')

    expect(scopes).toContain('pages_manage_posts')
    // dm is declared false, so the messaging permission must not be requested.
    // An app asking for permissions it does not use fails App Review.
    expect(scopes).not.toContain('pages_messaging')
    expect(redirect.state).toBe('s1')
  })
})

describe('connecting', () => {
  it('returns one account per Page the person can actually post to', async () => {
    stubGraph([
      { access_token: 'short' },
      { access_token: 'long', expires_in: 5_183_944 },
      {
        data: [
          { id: '1', name: 'Can Post', access_token: 't1', tasks: ['CREATE_CONTENT', 'MANAGE'] },
          { id: '2', name: 'Read Only', access_token: 't2', tasks: ['ANALYZE'] },
        ],
      },
    ])

    const accounts = await facebook.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )

    // The read-only Page is excluded. Connecting it would produce an account
    // that looks connected and fails on the first scheduled post — days later,
    // in front of an audience.
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.providerAccountId).toBe('1')
    expect(accounts[0]!.credential.accessToken).toBe('t1')
  })

  it('says so when the person manages Pages but can post to none', async () => {
    stubGraph([
      { access_token: 'short' },
      { access_token: 'long' },
      { data: [{ id: '2', name: 'Read Only', access_token: 't2', tasks: ['ANALYZE'] }] },
    ])

    await expect(
      facebook.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })
    ).rejects.toThrow(/see these Pages but not post to them/)
  })

  it('exchanges for a LONG-LIVED token before reading Pages', async () => {
    // Page tokens inherit their lifetime from whatever they were derived from.
    // Derive them from the one-hour token Login returns and every Page token
    // expires within the hour — which works in testing and breaks overnight.
    const calls = stubGraph([
      { access_token: 'short' },
      { access_token: 'long' },
      { data: [{ id: '1', name: 'P', access_token: 't', tasks: ['CREATE_CONTENT'] }] },
    ])

    await facebook.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })

    expect(calls[1]!.url).toContain('grant_type=fb_exchange_token')
    // And the Pages call comes after it, using the long-lived token.
    expect(calls[2]!.url).toContain('/me/accounts')
  })

  it('reports a denied authorization instead of a missing-code crash', async () => {
    await expect(
      facebook.handleCallback(
        { redirectUri: 'https://x.test/cb', state: 's' },
        { error: 'access_denied', error_description: 'User cancelled.' }
      )
    ).rejects.toThrow(/User cancelled/)
  })
})

describe('publishing', () => {
  it('posts text to the page feed', async () => {
    const calls = stubGraph([{ id: '1122334455_999' }])
    const result = await facebook.publish(ACCOUNT, CREDENTIAL, payload())

    expect(calls[0]!.url).toContain('/1122334455/feed')
    expect(calls[0]!.method).toBe('POST')
    expect(result.remoteId).toBe('1122334455_999')
  })

  it('sends the link explicitly so the right card is rendered', async () => {
    const calls = stubGraph([{ id: 'p1' }])
    await facebook.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ text: 'Read it at https://example.com/post. Thanks!' })
    )

    const body = new URLSearchParams(calls[0]!.body!)
    // Trailing sentence punctuation is not part of the URL. Including it gives
    // Facebook a link that 404s.
    expect(body.get('link')).toBe('https://example.com/post')
  })

  it('sends one photo straight to /photos and keeps the FEED story id', async () => {
    const calls = stubGraph([{ id: 'photo-1', post_id: '1122334455_777' }])
    const result = await facebook.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ media: [{ url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }] })
    )

    expect(calls[0]!.url).toContain('/photos')
    // post_id, not id: the feed story is what a person can actually open.
    expect(result.remoteId).toBe('1122334455_777')
  })

  it('uploads several photos UNPUBLISHED, then attaches them to one post', async () => {
    const calls = stubGraph([{ id: 'ph1' }, { id: 'ph2' }, { id: 'feed-1' }])
    const result = await facebook.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({
        media: [
          { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' },
          { url: 'https://cdn.test/b.jpg', mime: 'image/jpeg' },
        ],
      })
    )

    expect(new URLSearchParams(calls[0]!.body!).get('published')).toBe('false')
    expect(new URLSearchParams(calls[1]!.body!).get('published')).toBe('false')

    const feed = new URLSearchParams(calls[2]!.body!)
    expect(feed.get('attached_media[0]')).toBe('{"media_fbid":"ph1"}')
    expect(feed.get('attached_media[1]')).toBe('{"media_fbid":"ph2"}')
    expect(result.remoteId).toBe('feed-1')
  })

  it('deletes the orphaned photos when the feed post fails', async () => {
    // Meta offers no transaction, so a failure partway leaves real photo
    // objects on the Page. Left alone they are invisible litter that still
    // shows up in the Page's media library.
    let call = 0
    const deleted: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = String(input)
      call += 1
      if (init?.method === 'DELETE') {
        deleted.push(url)
        return new Response('{}', { status: 200 })
      }
      if (call <= 2) return new Response(JSON.stringify({ id: `ph${call}` }), { status: 200 })
      return new Response(JSON.stringify({ error: { code: 100, message: 'bad' } }), { status: 400 })
    })

    await expect(
      facebook.publish(
        ACCOUNT,
        CREDENTIAL,
        payload({
          media: [
            { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' },
            { url: 'https://cdn.test/b.jpg', mime: 'image/jpeg' },
          ],
        })
      )
    ).rejects.toThrow()

    expect(deleted.some((u) => u.includes('/ph1'))).toBe(true)
    expect(deleted.some((u) => u.includes('/ph2'))).toBe(true)
  })

  it('marks a video as PENDING, because it is still processing', async () => {
    const calls = stubGraph([{ id: 'vid-1' }])
    const result = await facebook.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ surface: 'feedVideo', media: [{ url: 'https://cdn.test/v.mp4', mime: 'video/mp4' }] })
    )

    expect(calls[0]!.url).toContain('graph-video.facebook.com')
    // Reporting it as published would be a claim we cannot support: the video
    // can still fail during processing, after this call returned success.
    expect(result.pending).toBe(true)
  })
})

describe('reading back', () => {
  it('widens the reconciliation window past the exact boundary', async () => {
    // The reconciler compares against when WE started; Facebook stamps when IT
    // finished. An exact boundary drops the very post being looked for.
    const calls = stubGraph([{ data: [] }])
    const since = new Date('2026-08-31T12:00:00Z')
    await facebook.retrievePosts!(ACCOUNT, CREDENTIAL, since)

    const sent = Number(new URL(calls[0]!.url).searchParams.get('since'))
    expect(sent).toBe(Math.floor((since.getTime() - 60_000) / 1000))
  })

  it('reports an unmeasured metric as null, never as zero', async () => {
    // A measured zero is data; an absent metric is not. "0 impressions" for
    // something nobody counted is a lie with a number attached.
    stubGraph([{ data: [{ name: 'post_clicks', values: [{ value: 4 }] }] }])
    const metrics = await facebook.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'p1')

    expect(metrics['clicks']).toBe(4)
    expect(metrics['impressions']).toBeNull()
  })

  it('sums the reaction breakdown into a single like count', async () => {
    stubGraph([
      {
        data: [
          { name: 'post_reactions_by_type_total', values: [{ value: { like: 3, love: 2, wow: 1 } }] },
        ],
      },
    ])
    const metrics = await facebook.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'p1')
    expect(metrics['likes']).toBe(6)
  })
})

describe('webhooks', () => {
  const raw = Buffer.from('{"object":"page"}', 'utf8')
  const sign = (secret: string) =>
    'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

  it('accepts a signature made with the app secret', () => {
    expect(facebook.verifyWebhook!(raw, { 'x-hub-signature-256': sign('secret-abc') })).toEqual({
      valid: true,
      providerAccountId: null,
    })
  })

  it('rejects a signature made with the wrong secret', () => {
    const result = facebook.verifyWebhook!(raw, { 'x-hub-signature-256': sign('wrong') })
    expect(result.valid).toBe(false)
  })

  it('rejects an unsigned request', () => {
    expect(facebook.verifyWebhook!(raw, {}).valid).toBe(false)
  })

  it('REFUSES when no app secret is configured', () => {
    // Never a pass. Skipping verification so it "works out of the box" turns
    // the endpoint into an open write into another tenant's inbox.
    delete process.env['META_APP_SECRET']
    expect(facebook.verifyWebhook!(raw, { 'x-hub-signature-256': sign('secret-abc') }).valid).toBe(
      false
    )
  })

  it('parses a comment into a message on the post it belongs to', () => {
    const events = facebook.parseWebhook!({
      entry: [
        {
          id: '1122334455',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'c1',
                post_id: 'p1',
                message: 'Nice',
                from: { name: 'Ada' },
                created_time: 1_756_000_000,
              },
            },
          ],
        },
      ],
    })

    expect(events).toHaveLength(1)
    // The POST is the conversation; the comment is a message in it.
    expect(events[0]!.providerConversationId).toBe('p1')
    expect(events[0]!.providerMessageId).toBe('c1')
    expect(events[0]!.providerCreatedAt.toISOString()).toBe('2025-08-24T01:46:40.000Z')
  })

  it('ignores our own posts arriving on the same subscription', () => {
    // A Page's own publishes come back through the feed subscription. Filing
    // them as inbound would report our own posts as audience activity.
    const events = facebook.parseWebhook!({
      entry: [{ id: '1', changes: [{ field: 'feed', value: { item: 'status', verb: 'add' } }] }],
    })
    expect(events).toEqual([])
  })
})

describe('error mapping', () => {
  it('treats a dead token as needing reconnection, not as a failed post', () => {
    const error = mapGraphError('facebook', 400, { error: { code: 190, message: 'expired' } })
    expect(error.code).toBe('TokenExpired')
    expect(error.requiresReauth).toBe(true)
  })

  it('maps the four rate-limit codes, which are different scopes of the same thing', () => {
    for (const code of [4, 17, 32, 613]) {
      expect(mapGraphError('facebook', 400, { error: { code } }).code).toBe('RateLimited')
    }
  })

  it('maps a Meta-side fault to ProviderDown, so it reconciles rather than retries blindly', () => {
    expect(mapGraphError('facebook', 500, { error: { code: 2 } }).code).toBe('ProviderDown')
  })

  it('prefers the user-facing message when Meta supplies one', () => {
    const error = mapGraphError('facebook', 400, {
      error: { code: 368, message: 'internal prose', error_user_msg: 'Your Page is restricted.' },
    })
    expect(error.message).toContain('Your Page is restricted.')
  })

  it('keeps the trace id, which is what Meta support asks for', () => {
    const error = mapGraphError('facebook', 400, {
      error: { code: 100, message: 'bad', fbtrace_id: 'Abc123' },
    })
    expect(error.options.providerRequestId).toBe('Abc123')
  })

  it('does not retry a request that is simply wrong', () => {
    const error = mapGraphError('facebook', 400, { error: { code: 100, message: 'bad param' } })
    expect(error.code).toBe('ContentRejected')
    expect(error.retryable).toBe(false)
  })
})
