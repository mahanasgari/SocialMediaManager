import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstagramProvider } from './adapter.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const instagram = new InstagramProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: '17841400000000000',
  handle: '@northwind',
  displayName: 'Northwind',
  platformMeta: { pageId: '1122334455' },
}
const CREDENTIAL: Credential = { accessToken: 'page-token', scopes: [] }

const IMAGE = { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'feedImage',
  text: 'Hello',
  media: [IMAGE],
  idempotencyKey: 'k1',
  ...over,
})

/** Answers each call with the next queued body, recording what was asked. */
function stubGraph(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    })
    return new Response(JSON.stringify(responses[i++] ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  return calls
}

beforeEach(() => {
  process.env['META_APP_ID'] = 'app-123'
  process.env['META_APP_SECRET'] = 'secret-abc'
  // The poll sleeps five seconds between checks. Fake timers would need every
  // await threaded through them; advancing real time is not an option in a
  // test suite, so the polling tests below queue an immediate FINISHED.
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['META_APP_ID']
  delete process.env['META_APP_SECRET']
})

describe('validation', () => {
  it('refuses a text-only post in the COMPOSER, not at publish time', () => {
    // Instagram has no text-only post. Discovering that when a scheduled post
    // fails at 9am is the failure this check exists to prevent.
    const issues = instagram.validate({
      surface: 'feedImage',
      text: 'Just words',
      media: [],
    })
    expect(issues.some((i) => i.code === 'media_required')).toBe(true)
  })

  it('accepts a post that carries an image', () => {
    const issues = instagram.validate({
      surface: 'feedImage',
      text: 'With a picture',
      media: [{ mime: 'image/jpeg', bytes: 1000, width: 1080, height: 1080 }],
    })
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('connecting', () => {
  it('keeps only Pages with a linked Instagram account', async () => {
    stubGraph([
      { access_token: 'short' },
      { access_token: 'long' },
      {
        data: [
          { id: 'p1', name: 'Has IG', access_token: 't1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: 'ig1' } },
          { id: 'p2', name: 'No IG', access_token: 't2', tasks: ['CREATE_CONTENT'] },
        ],
      },
      { username: 'northwind', name: 'Northwind' },
    ])

    const accounts = await instagram.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )

    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.providerAccountId).toBe('ig1')
    // The Instagram username, not the Page name. They are routinely different,
    // and showing the Page name under an Instagram icon makes people connect
    // the wrong account.
    expect(accounts[0]!.handle).toBe('@northwind')
  })

  it('names the actual cause when nothing is linked', async () => {
    stubGraph([
      { access_token: 'short' },
      { access_token: 'long' },
      { data: [{ id: 'p2', name: 'No IG', access_token: 't2', tasks: ['CREATE_CONTENT'] }] },
    ])

    // "No accounts found" would send someone hunting through permissions. The
    // usual cause is a Personal account, and the message says so.
    await expect(
      instagram.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })
    ).rejects.toThrow(/personal Instagram account cannot publish/i)
  })

  it('keeps the Page id, which is what the DM endpoint needs', async () => {
    stubGraph([
      { access_token: 'short' },
      { access_token: 'long' },
      { data: [{ id: 'p1', name: 'P', access_token: 't1', tasks: [], instagram_business_account: { id: 'ig1' } }] },
      { username: 'n' },
    ])

    const accounts = await instagram.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )
    expect((accounts[0]!.platformMeta as { pageId: string }).pageId).toBe('p1')
  })
})

describe('publishing', () => {
  it('creates a container, waits for it, then publishes it', async () => {
    const calls = stubGraph([
      { id: 'container-1' },
      { status_code: 'FINISHED' },
      { id: 'media-1' },
    ])

    const result = await instagram.publish(ACCOUNT, CREDENTIAL, payload())

    expect(calls[0]!.url).toContain('/17841400000000000/media')
    expect(calls[1]!.url).toContain('/container-1')
    expect(calls[2]!.url).toContain('/media_publish')
    expect(new URLSearchParams(calls[2]!.body!).get('creation_id')).toBe('container-1')
    expect(result.remoteId).toBe('media-1')
  })

  it('sends image_url, because Instagram FETCHES the media', async () => {
    // There is no upload on this API. The URL must be reachable from Meta's
    // servers, which is what MEDIA_PUBLIC_MODE and the signed relay are for.
    const calls = stubGraph([{ id: 'c1' }, { status_code: 'FINISHED' }, { id: 'm1' }])
    await instagram.publish(ACCOUNT, CREDENTIAL, payload())

    const body = new URLSearchParams(calls[0]!.body!)
    expect(body.get('image_url')).toBe('https://cdn.test/a.jpg')
    expect(body.get('caption')).toBe('Hello')
  })

  it('returns no remoteUrl rather than a constructed one that 404s', async () => {
    stubGraph([{ id: 'c1' }, { status_code: 'FINISHED' }, { id: 'm1' }])
    const result = await instagram.publish(ACCOUNT, CREDENTIAL, payload())

    // A broken link in the UI is worse than no link: it looks like the post
    // was deleted.
    expect(result.remoteUrl).toBeUndefined()
  })

  it('marks carousel children so they do not publish as separate posts', async () => {
    const calls = stubGraph([
      { id: 'child-1' },
      { id: 'child-2' },
      { status_code: 'FINISHED' },
      { status_code: 'FINISHED' },
      { id: 'parent-1' },
      { status_code: 'FINISHED' },
      { id: 'media-1' },
    ])

    await instagram.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ media: [IMAGE, { url: 'https://cdn.test/b.jpg', mime: 'image/jpeg' }] })
    )

    // Without is_carousel_item a two-image carousel publishes as two separate
    // posts — immediately visible, and undoable only by deleting both.
    expect(new URLSearchParams(calls[0]!.body!).get('is_carousel_item')).toBe('true')
    expect(new URLSearchParams(calls[1]!.body!).get('is_carousel_item')).toBe('true')

    const parent = new URLSearchParams(calls[4]!.body!)
    expect(parent.get('media_type')).toBe('CAROUSEL')
    expect(parent.get('children')).toBe('child-1,child-2')
  })

  it('treats a rejected container as InvalidMedia, not as something to retry', async () => {
    stubGraph([{ id: 'c1' }, { status_code: 'ERROR', status: 'Aspect ratio not supported' }])

    await expect(instagram.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'InvalidMedia',
    })
  })

  it('reports an expired container honestly rather than as a timeout', async () => {
    stubGraph([{ id: 'c1' }, { status_code: 'EXPIRED' }])
    await expect(instagram.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'PermanentFailure',
    })
  })

  it('treats an ALREADY PUBLISHED container as done, never publishing it twice', async () => {
    // The reconciliation case. If an earlier attempt published and we never saw
    // the response, publishing again duplicates a live post — which cannot be
    // undone.
    const calls = stubGraph([{ id: 'c1' }, { status_code: 'PUBLISHED' }, { id: 'm1' }])
    const result = await instagram.publish(ACCOUNT, CREDENTIAL, payload())

    expect(result.remoteId).toBe('m1')
    // Three calls: create, check, publish. No second container was created.
    expect(calls.filter((c) => c.url.endsWith('/media') && c.method === 'POST')).toHaveLength(1)
  })

  it('refuses a text-only publish at the adapter too, not only in the composer', async () => {
    await expect(
      instagram.publish(ACCOUNT, CREDENTIAL, payload({ media: [] }))
    ).rejects.toThrow(/must include at least one image or video/)
  })
})

describe('reading back', () => {
  it('filters by date locally, because Instagram ignores `since` on this edge', async () => {
    stubGraph([
      {
        data: [
          { id: 'new', caption: 'recent', timestamp: '2026-08-31T12:00:00+0000' },
          { id: 'old', caption: 'ancient', timestamp: '2026-01-01T12:00:00+0000' },
        ],
      },
    ])

    const posts = await instagram.retrievePosts!(
      ACCOUNT,
      CREDENTIAL,
      new Date('2026-08-31T11:00:00Z')
    )

    // Pretending the parameter worked would silently return everything, and
    // the reconciler would match against posts from months ago.
    expect(posts.map((p) => p.remoteId)).toEqual(['new'])
  })

  it('counts carousel children as the media count', async () => {
    stubGraph([
      {
        data: [
          {
            id: 'p1',
            timestamp: '2026-08-31T12:00:00+0000',
            children: { data: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
          },
        ],
      },
    ])

    const posts = await instagram.retrievePosts!(ACCOUNT, CREDENTIAL, new Date('2026-08-01'))
    expect(posts[0]!.mediaCount).toBe(3)
  })

  it('reports a metric Instagram omitted as null, not zero', async () => {
    // Instagram omits metrics that do not apply to a media type. Flattening
    // that to 0 reports engagement nobody measured.
    stubGraph([{ data: [{ name: 'reach', values: [{ value: 120 }] }] }])
    const metrics = await instagram.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'm1')

    expect(metrics['reach']).toBe(120)
    expect(metrics['saves']).toBeNull()
  })
})

describe('messaging', () => {
  it('sends from the PAGE, which owns the Instagram inbox', async () => {
    const calls = stubGraph([{ message_id: 'mid1' }])
    await instagram.sendMessage!(ACCOUNT, CREDENTIAL, 'user-1', 'Thanks!')

    expect(calls[0]!.url).toContain('/1122334455/messages')
  })

  it('says what is wrong when the Page id is missing, rather than failing obscurely', async () => {
    await expect(
      instagram.sendMessage!(
        { ...ACCOUNT, platformMeta: {} },
        CREDENTIAL,
        'user-1',
        'Hi'
      )
    ).rejects.toThrow(/no linked Page id/)
  })
})

describe('webhooks', () => {
  it('parses a comment onto the media it belongs to', () => {
    const events = instagram.parseWebhook!({
      entry: [
        {
          id: 'ig1',
          time: 1_756_000_000,
          changes: [
            {
              field: 'comments',
              value: { id: 'c1', text: 'Nice', media: { id: 'm1' }, from: { username: 'ada' } },
            },
          ],
        },
      ],
    })

    expect(events[0]!.kind).toBe('COMMENT_THREAD')
    expect(events[0]!.providerConversationId).toBe('m1')
    expect(events[0]!.authorHandle).toBe('ada')
  })

  it('parses a direct message as a DM, not as a comment', () => {
    // Two shapes arrive on one subscription. Treating them alike loses the
    // distinction between a public reply and a private one.
    const events = instagram.parseWebhook!({
      entry: [
        {
          id: 'ig1',
          messaging: [
            {
              sender: { id: 'u1' },
              timestamp: 1_756_000_000_000,
              message: { mid: 'mid1', text: 'Is this in stock?' },
            },
          ],
        },
      ],
    })

    expect(events[0]!.kind).toBe('DM')
    expect(events[0]!.body).toBe('Is this in stock?')
  })

  it('ignores the echo of our own outbound message', () => {
    // Without this every reply we send appears in the inbox as a message from
    // the customer.
    const events = instagram.parseWebhook!({
      entry: [
        {
          id: 'ig1',
          messaging: [
            { sender: { id: 'ig1' }, message: { mid: 'e1', text: 'our reply', is_echo: true } },
          ],
        },
      ],
    })
    expect(events).toEqual([])
  })

  it('REFUSES when no app secret is configured', () => {
    delete process.env['META_APP_SECRET']
    expect(
      instagram.verifyWebhook!(Buffer.from('{}'), { 'x-hub-signature-256': 'sha256=whatever' }).valid
    ).toBe(false)
  })
})
