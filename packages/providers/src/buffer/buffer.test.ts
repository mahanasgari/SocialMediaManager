import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstagramBufferProvider } from '../instagramBuffer/adapter.js'
import { FacebookBufferProvider } from '../facebookBuffer/adapter.js'
import { assetsFor, channelsOfService, toRemotePost } from './route.js'
import { resetOrganizationCache } from './client.js'
import { ProviderError } from '../errors.js'
import type { Account, Credential, PublishPayload } from '../base.js'

/**
 * The Buffer route.
 *
 * Two things get the most attention here, because they are the two that would
 * fail silently: GraphQL reporting failure inside an HTTP 200, and the
 * difference between what Instagram requires and what Facebook allows. A
 * transport that only checked response.ok would call every rejected post a
 * success, and a Facebook connector that inherited Instagram's media rule would
 * refuse ordinary status updates.
 */

const instagram = new InstagramBufferProvider()
const facebook = new FacebookBufferProvider()

const CREDENTIAL: Credential = { accessToken: 'buffer-key', scopes: ['buffer'] }

const IG_ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: 'ch_ig_1',
  handle: '@northwind',
  displayName: 'Northwind',
  platformMeta: { bufferChannelId: 'ch_ig_1' },
}
const FB_ACCOUNT: Account = { ...IG_ACCOUNT, providerAccountId: 'ch_fb_1', handle: 'Northwind' }

const IMAGE = { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'feedImage',
  text: 'Hello',
  media: [IMAGE],
  idempotencyKey: 'k1',
  ...over,
})

/**
 * Answers each call with the next queued response, recording the request.
 *
 * The `account` lookup is answered automatically and neither queued nor
 * recorded. Every channel and post operation needs an organizationId first —
 * Buffer requires it and the docs' examples omit it — and making forty tests
 * each prepend the same account response would bury what each one is actually
 * about.
 */
function stub(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ body: string | undefined }> = []
  let i = 0

  vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
    const sent = init?.body as string | undefined

    if (sent?.includes('query Account')) {
      return new Response(
        JSON.stringify({ data: { account: { id: 'acc_1', organizations: [{ id: 'org_1' }] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    calls.push({ body: sent })
    const next = responses[i++] ?? { body: {} }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  })

  return calls
}

const channels = (list: unknown[]) => ({ body: { data: { channels: list } } })

afterEach(() => {
  vi.unstubAllGlobals()
  // The organization is cached per key for the process lifetime, which is right
  // in production and would leak one test's account into the next here.
  resetOrganizationCache()
})

describe('reading the channel list', () => {
  it('keeps only channels of the network the connector serves', () => {
    const list = [
      { id: '1', name: 'a', service: 'instagram' },
      { id: '2', name: 'b', service: 'facebook' },
      { id: '3', name: 'c', service: 'twitter' },
    ]
    expect(channelsOfService(list, 'instagram').map((c) => c.id)).toEqual(['1'])
    expect(channelsOfService(list, 'facebook').map((c) => c.id)).toEqual(['2'])
  })

  it('matches the service name regardless of case', () => {
    // Buffer has renamed several of these over the years. An exact match that
    // missed would report "no Instagram channels" to someone looking at one.
    const list = [{ id: '1', name: 'a', service: 'Instagram' }]
    expect(channelsOfService(list, 'instagram')).toHaveLength(1)
  })

  it('survives a channel with no service rather than throwing', () => {
    const list = [{ id: '1', name: 'a' } as unknown as { id: string; name: string; service: string }]
    expect(channelsOfService(list, 'instagram')).toEqual([])
  })
})

describe('connecting with a key', () => {
  it('returns one account per Instagram channel, each carrying the key', async () => {
    stub([
      channels([
        { id: 'ch_ig_1', name: 'northwind', service: 'instagram', displayName: 'Northwind' },
        { id: 'ch_ig_2', name: 'southwind', service: 'instagram' },
        { id: 'ch_fb_1', name: 'Page', service: 'facebook' },
      ]),
    ])

    const found = await instagram.handleCallback({} as never, { apiKey: 'buffer-key' })

    expect(found).toHaveLength(2)
    expect(found.map((a) => a.providerAccountId)).toEqual(['ch_ig_1', 'ch_ig_2'])
    // Every discovered account carries the same key, which is what lets one be
    // disconnected without stranding the others.
    expect(found.every((a) => a.credential.accessToken === 'buffer-key')).toBe(true)
  })

  it('adds the @ Instagram handles are written with, without doubling it', async () => {
    stub([
      channels([
        { id: '1', name: 'plain', service: 'instagram' },
        { id: '2', name: '@already', service: 'instagram' },
      ]),
    ])

    const found = await instagram.handleCallback({} as never, { apiKey: 'k' })
    expect(found.map((a) => a.handle)).toEqual(['@plain', '@already'])
  })

  it('leaves a Facebook Page name alone, because Pages are not @handles', async () => {
    stub([channels([{ id: '1', name: 'Northwind Traders', service: 'facebook' }])])

    const found = await facebook.handleCallback({} as never, { apiKey: 'k' })
    expect(found[0]?.handle).toBe('Northwind Traders')
  })

  it('distinguishes an empty Buffer account from one with no Instagram', async () => {
    // The two need different fixes, and a single message would send someone to
    // retype a key that was never the problem.
    stub([channels([])])
    await expect(instagram.handleCallback({} as never, { apiKey: 'k' })).rejects.toThrow(
      /no channels connected/i
    )

    stub([channels([{ id: '1', name: 'p', service: 'facebook' }])])
    await expect(instagram.handleCallback({} as never, { apiKey: 'k' })).rejects.toThrow(
      /no Instagram one/i
    )
  })

  it('refuses an empty key without calling Buffer', async () => {
    const calls = stub([])
    await expect(instagram.handleCallback({} as never, { apiKey: '  ' })).rejects.toThrow(
      /API key is required/
    )
    expect(calls).toHaveLength(0)
  })

  it('has no authorize URL to offer, and says what to do instead', async () => {
    await expect(instagram.getAuthUrl({} as never)).rejects.toThrow(/Settings → API/)
  })
})

describe('errors arriving as data', () => {
  it('treats a GraphQL error inside a 200 as a failure', async () => {
    // The whole reason the transport does not just check response.ok.
    stub([{ status: 200, body: { errors: [{ message: 'Channel is disconnected' }] } }])

    await expect(
      instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())
    ).rejects.toThrow('Channel is disconnected')
  })

  it('treats the MutationError arm of createPost as a rejection, not a success', async () => {
    stub([
      {
        body: {
          data: { createPost: { __typename: 'MutationError', message: 'Caption too long' } },
        },
      },
    ])

    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe('ContentRejected')
    // A refusal with a reason must not be retried into a rate limit.
    expect((error as ProviderError).retryable).toBe(false)
  })

  it('maps a 401 to a broken connection rather than a retry', async () => {
    stub([{ status: 401, body: {} }])

    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect((error as ProviderError).code).toBe('PermissionRevoked')
    expect((error as ProviderError).requiresReauth).toBe(true)
  })

  it('honours retry-after on a 429', async () => {
    stub([{ status: 429, body: {}, headers: { 'retry-after': '90' } }])

    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect((error as ProviderError).code).toBe('RateLimited')
    expect((error as ProviderError).retryable).toBe(true)
    expect((error as ProviderError).options.retryAfterSeconds).toBe(90)
  })

  it('treats an unrecognised error code as permanent rather than retrying blindly', async () => {
    stub([{ status: 200, body: { errors: [{ message: 'no', extensions: { code: 'WHAT' } }] } }])

    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect((error as ProviderError).retryable).toBe(false)
  })

  it('reports a 500 as retryable', async () => {
    stub([{ status: 503, body: {} }])
    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect((error as ProviderError).code).toBe('ProviderDown')
    expect((error as ProviderError).retryable).toBe(true)
  })
})

describe('what each network requires', () => {
  it('refuses an Instagram post with no media, naming the actual problem', async () => {
    const calls = stub([])

    await expect(
      instagram.publish(IG_ACCOUNT, CREDENTIAL, payload({ media: [] }))
    ).rejects.toThrow(/need an image or a video/i)

    // Caught before the request, so the person is told now rather than after
    // Buffer relays Meta's refusal later.
    expect(calls).toHaveLength(0)
  })

  it('ALLOWS a text-only Facebook post, which Instagram would have refused', async () => {
    // The mistake this guards: copying the Instagram rule into its twin. A
    // status update with no media is an ordinary Facebook post.
    const calls = stub([
      { body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1' } } } } },
    ])

    const result = await facebook.publish(
      FB_ACCOUNT,
      CREDENTIAL,
      payload({ surface: 'feed', media: [] })
    )

    expect(result.remoteId).toBe('p1')
    expect(calls).toHaveLength(1)
    // An EMPTY LIST, not an omitted field. `assets` is non-null in Buffer's
    // schema, so omitting it fails validation — which is what the first version
    // did, and it would have broken every text-only Facebook post.
    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      variables: { input: { assets: unknown[] } }
    }
    expect(body.variables.input.assets).toEqual([])
  })

  it('refuses a Facebook post that is neither text nor media', async () => {
    stub([])
    await expect(
      facebook.publish(FB_ACCOUNT, CREDENTIAL, payload({ surface: 'feed', text: '  ', media: [] }))
    ).rejects.toThrow(/needs text, an image or a video/i)
  })
})

describe('sending a post', () => {
  it('sends one mutation for one channel, carrying the text and asset', async () => {
    const calls = stub([
      {
        body: {
          data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: { id: 'p1', status: 'sent' },
            },
          },
        },
      },
    ])

    const result = await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload({ text: 'Hi there' }))

    expect(result).toEqual({ remoteId: 'p1', pending: false })
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      variables: { input: { channelId: string; text: string; assets: unknown[] } }
    }
    expect(sent.variables.input.channelId).toBe('ch_ig_1')
    expect(sent.variables.input.text).toBe('Hi there')
    expect(sent.variables.input.assets).toEqual([{ image: { url: 'https://cdn.test/a.jpg' } }])
  })

  it('publishes NOW rather than handing the timing back to Buffer', async () => {
    // publish() is called by the worker only once scheduledAt has passed, so it
    // means "send this now". addToQueue would give the decision back to
    // Buffer's own posting schedule — a post scheduled for 09:00 would go out
    // whenever Buffer's next slot came round, and the calendar would show a
    // time that never happened.
    const calls = stub([
      { body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p' } } } } },
    ])

    await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())

    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      variables: { input: { mode: string; dueAt?: string } }
    }
    expect(sent.variables.input.mode).toBe('shareNow')
    expect(sent.variables.input.dueAt).toBeUndefined()
  })

  it('sends the fields Buffer REQUIRES, which the documented examples omit', async () => {
    // Checked against the live schema. Every one of these was missing or wrong
    // in the first version, which passed forty tests and could not have made a
    // single successful call:
    //   organizationId — required by channels and posts
    //   needsApproval  — required by createPost, in no published example
    //   assets         — non-null, so always sent
    const calls = stub([
      { body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p' } } } } },
    ])

    await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())

    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      query: string
      variables: { input: Record<string, unknown> }
    }
    expect(sent.variables.input['needsApproval']).toBe(false)
    expect(sent.variables.input['assets']).toBeDefined()
    // The union is PostActionPayload, so a fragment on MutationError would be a
    // validation error rather than a fallback.
    expect(sent.query).toContain('PostActionSuccess')
    expect(sent.query).not.toContain('MutationError')
  })

  it('asks the channel list for an organization, because Buffer requires one', async () => {
    const calls = stub([{ body: { data: { channels: [] } } }])
    await instagram.handleCallback({} as never, { apiKey: 'k' }).catch(() => undefined)

    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      variables: { input: { organizationId: string } }
    }
    expect(sent.variables.input.organizationId).toBe('org_1')
  })

  it('maps each arm of the result union onto the retry taxonomy', async () => {
    // Six error types, and the difference decides whether the scheduler backs
    // off, stops, or gives up. One generic failure would get all three wrong.
    const cases = [
      ['UnauthorizedError', 'PermissionRevoked', false],
      ['LimitReachedError', 'RateLimited', true],
      ['UnexpectedError', 'ProviderDown', true],
      ['NotFoundError', 'PermanentFailure', false],
      ['InvalidInputError', 'ContentRejected', false],
      ['RestProxyError', 'ContentRejected', false],
    ] as const

    for (const [typename, code, retryable] of cases) {
      stub([{ body: { data: { createPost: { __typename: typename, message: 'nope' } } } }])
      const error = await instagram
        .publish(IG_ACCOUNT, CREDENTIAL, payload())
        .catch((e: unknown) => e)

      expect((error as ProviderError).code, typename).toBe(code)
      expect((error as ProviderError).retryable, typename).toBe(retryable)
      resetOrganizationCache()
    }
  })

  it('treats a post Buffer accepted and then failed to send as rejected content', async () => {
    stub([
      {
        body: {
          data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: {
                id: 'p',
                status: 'error',
                error: { message: 'Instagram refused the aspect ratio' },
              },
            },
          },
        },
      },
    ])

    const error = await instagram
      .publish(IG_ACCOUNT, CREDENTIAL, payload())
      .catch((e: unknown) => e)

    expect((error as ProviderError).code).toBe('ContentRejected')
    expect((error as ProviderError).message).toMatch(/aspect ratio/)
    // Retrying would send the same rejected content again.
    expect((error as ProviderError).retryable).toBe(false)
  })

  it('returns the network permalink when Buffer has one, and no link when it does not', async () => {
    stub([
      {
        body: {
          data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: { id: 'p', status: 'sent', externalLink: 'https://instagram.com/p/abc' },
            },
          },
        },
      },
    ])
    const withLink = await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())
    expect(withLink.remoteUrl).toBe('https://instagram.com/p/abc')

    resetOrganizationCache()
    stub([
      { body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'q' } } } } },
    ])
    const noLink = await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())
    // Absent rather than a dead link on the posts list.
    expect(noLink.remoteUrl).toBeUndefined()
  })

  it('keeps a usable answer even when Buffer errors on a field beside it', async () => {
    // Buffer answers a partly-forbidden query with BOTH data and errors. A real
    // key does this. Throwing on any error would discard the channels over a
    // field we can live without.
    stub([
      {
        body: {
          data: { channels: [{ id: 'c1', name: 'x', service: 'instagram' }] },
          errors: [{ message: 'Not authorized to access this resource' }],
        },
      },
    ])

    const found = await instagram.handleCallback({} as never, { apiKey: 'k' })
    expect(found).toHaveLength(1)
  })

  it('reports a post Buffer has not sent yet as pending', async () => {
    stub([
      {
        body: {
          data: {
            createPost: { __typename: 'PostActionSuccess', post: { id: 'p2', status: 'buffer' } },
          },
        },
      },
    ])

    const result = await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())
    expect(result.pending).toBe(true)
    // Buffer's id, not Instagram's — there is no permalink until it sends.
    expect(result.remoteUrl).toBeUndefined()
  })

  it('sends the key as a bearer token', async () => {
    let auth: string | null = null
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization')
      return new Response(
        JSON.stringify({
          data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p' } } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    await instagram.publish(IG_ACCOUNT, CREDENTIAL, payload())
    expect(auth).toBe('Bearer buffer-key')
  })
})

describe('turning media into assets', () => {
  it('sends a video as a video and an image as an image', () => {
    expect(
      assetsFor([
        { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' },
        { url: 'https://cdn.test/b.mp4', mime: 'video/mp4' },
      ])
    ).toEqual([{ image: { url: 'https://cdn.test/a.jpg' } }, { video: { url: 'https://cdn.test/b.mp4' } }])
  })

  it('produces nothing for no media', () => {
    expect(assetsFor([])).toEqual([])
  })
})

describe('reading posts back', () => {
  it('returns only posts at or after the reconciliation window', async () => {
    stub([
      {
        body: {
          data: {
            posts: {
              edges: [
                { node: { id: 'new', text: 'a', createdAt: '2026-09-06T12:00:00Z' } },
                { node: { id: 'old', text: 'b', createdAt: '2026-01-01T00:00:00Z' } },
              ],
            },
          },
        },
      },
    ])

    const found = await instagram.retrievePosts(
      IG_ACCOUNT,
      CREDENTIAL,
      new Date('2026-09-01T00:00:00Z')
    )
    expect(found.map((p) => p.remoteId)).toEqual(['new'])
  })

  it('counts media from the assets Buffer returns, never assuming zero', async () => {
    // The bug this locks down is severe and silent. Fingerprint matching
    // REJECTS a candidate whose media count differs, so a hardcoded zero made
    // every Instagram post unmatchable — an Instagram post always has media.
    // A lost response would then reconcile to "not published", the variant
    // would be retried, and the result is a duplicate public post.
    stub([
      {
        body: {
          data: {
            posts: {
              edges: [
                {
                  node: {
                    id: 'p1',
                    text: 'a',
                    createdAt: '2026-09-06T12:00:00Z',
                    assets: [{ id: 'a1' }, { id: 'a2' }],
                  },
                },
              ],
            },
          },
        },
      },
    ])

    const found = await instagram.retrievePosts(IG_ACCOUNT, CREDENTIAL, new Date(0))
    expect(found[0]?.mediaCount).toBe(2)
  })

  it('asks Buffer for the assets, or the count could not be right', async () => {
    const calls = stub([{ body: { data: { posts: { edges: [] } } } }])
    await instagram.retrievePosts(IG_ACCOUNT, CREDENTIAL, new Date(0))
    expect(calls[0]?.body).toContain('assets')
  })

  it('drops an undated post from the window rather than matching it wrongly', () => {
    // The epoch fallback is deliberate: an unknown date must fall OUTSIDE any
    // recent window, never inside one.
    const post = toRemotePost({ id: 'x', text: 'hello' })
    expect(post.createdAt.getTime()).toBe(0)
    expect(post.text).toBe('hello')
  })

  it('copes with a posts response that has no edges', async () => {
    stub([{ body: { data: { posts: {} } } }])
    await expect(
      instagram.retrievePosts(IG_ACCOUNT, CREDENTIAL, new Date(0))
    ).resolves.toEqual([])
  })
})

describe('metrics', () => {
  it('flattens Buffer’s name/value metrics into the shape the ingester stores', async () => {
    stub([
      {
        body: {
          data: {
            post: {
              id: 'p1',
              metrics: [
                { name: 'impressions', value: 120 },
                { name: 'reactions', value: 8 },
                { name: 'reach', value: null },
              ],
            },
          },
        },
      },
    ])

    await expect(instagram.fetchPostMetrics(IG_ACCOUNT, CREDENTIAL, 'p1')).resolves.toEqual({
      impressions: 120,
      reactions: 8,
      reach: null,
    })
  })

  it('returns nothing rather than throwing when Buffer has no metrics yet', async () => {
    stub([{ body: { data: { post: { id: 'p1', metrics: null } } } }])
    await expect(instagram.fetchPostMetrics(IG_ACCOUNT, CREDENTIAL, 'p1')).resolves.toEqual({})
  })
})

describe('the profile check', () => {
  it('reports a channel removed inside Buffer as a broken connection', async () => {
    // Must be PermissionRevoked, not a retry: the channel is not coming back on
    // its own, and the account belongs in NEEDS_REAUTH.
    stub([channels([{ id: 'someone-else', name: 'x', service: 'instagram' }])])

    const error = await instagram
      .fetchProfile(IG_ACCOUNT, CREDENTIAL)
      .catch((e: unknown) => e)

    expect((error as ProviderError).code).toBe('PermissionRevoked')
    expect((error as ProviderError).requiresReauth).toBe(true)
  })

  it('returns the current name when the channel is still there', async () => {
    stub([channels([{ id: 'ch_ig_1', name: 'northwind', service: 'instagram', displayName: 'NW' }])])

    await expect(instagram.fetchProfile(IG_ACCOUNT, CREDENTIAL)).resolves.toEqual({
      handle: '@northwind',
      displayName: 'NW',
    })
  })
})

describe('the key does not expire', () => {
  it('returns the credential unchanged instead of throwing at the refresher', async () => {
    // A sweep over every account must not produce a permanent, meaningless
    // error on an account whose credential is simply eternal.
    await expect(instagram.refreshToken(CREDENTIAL)).resolves.toEqual({
      accessToken: 'buffer-key',
      scopes: ['buffer'],
    })
  })
})

describe('the honesty of the matrix', () => {
  it('declares no engagement, because Buffer exposes none', () => {
    for (const provider of [instagram, facebook]) {
      expect(provider.capabilities.comments).toBe(false)
      expect(provider.capabilities.dm).toBe(false)
      expect(provider.capabilities.replies).toBe(false)
      expect(provider.capabilities.mentions).toBe(false)
      // And the methods genuinely do not exist — the contract suite enforces
      // the pairing, this states the intent at the point it matters.
      expect((provider as { sendMessage?: unknown }).sendMessage).toBeUndefined()
      expect((provider as { fetchComments?: unknown }).fetchComments).toBeUndefined()
    }
  })

  it('declares deletePost FALSE even though Buffer has a delete mutation', () => {
    // The subtle one. Buffer's delete removes Buffer's record; the post stays
    // up on the network. Declaring true would let someone watch a row vanish
    // while the post remained public.
    for (const provider of [instagram, facebook]) {
      expect(provider.capabilities.deletePost).toBe(false)
      expect((provider as { deletePost?: unknown }).deletePost).toBeUndefined()
    }
  })

  it('declares retrievePosts TRUE, which is what makes a lost response recoverable', () => {
    for (const provider of [instagram, facebook]) {
      expect(provider.capabilities.retrievePosts).toBe(true)
      expect(typeof (provider as { retrievePosts?: unknown }).retrievePosts).toBe('function')
    }
  })

  it('carries a notice about what the route cannot do', () => {
    for (const provider of [instagram, facebook]) {
      const notice = (provider as { notice?: string }).notice ?? ''
      expect(notice).toMatch(/inbox/i)
      expect(notice).toMatch(/publicly reachable/i)
    }
  })

  it('needs no operator configuration, unlike the direct Meta connectors', () => {
    expect(instagram.isConfigured()).toBe(true)
    expect(facebook.isConfigured()).toBe(true)
    expect(instagram.authStyle).toBe('credentials')
  })

  it('differs from Instagram where Facebook genuinely differs', () => {
    // If these ever match, one of them has been copied rather than declared.
    expect(instagram.text['feedImage']?.maxLength).toBe(2200)
    expect(facebook.text['feed']?.maxLength).toBe(63_206)
    expect(instagram.text['feedImage']?.linkHandling).toBe('stripped')
    expect(facebook.text['feed']?.linkHandling).toBe('counted')
    expect(instagram.capabilities.linkPost).toBe(false)
    expect(facebook.capabilities.linkPost).toBe(true)
  })
})
