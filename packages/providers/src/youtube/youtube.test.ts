import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YouTubeProvider, secondsUntilPacificMidnight, youtubeTitle } from './adapter.js'
import { limits } from './capabilities.js'
import type { Account, Credential, PublishPayload } from '../base.js'

const youtube = new YouTubeProvider()

const ACCOUNT: Account = {
  id: 'a1',
  providerAccountId: 'UC123',
  handle: '@northwind',
  displayName: 'Northwind',
  platformMeta: { channelId: 'UC123' },
}
const CREDENTIAL: Credential = { accessToken: 'tok', refreshToken: 'ref', scopes: [] }

const payload = (over: Partial<PublishPayload> = {}): PublishPayload => ({
  surface: 'feedVideo',
  text: 'A short film',
  media: [{ url: 'https://cdn.test/v.mp4', mime: 'video/mp4' }],
  idempotencyKey: 'k1',
  ...over,
})

function stub(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  let i = 0

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
    const next = responses[i++] ?? {}
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  })

  return calls
}

beforeEach(() => {
  process.env['GOOGLE_CLIENT_ID'] = 'goog-id'
  process.env['GOOGLE_CLIENT_SECRET'] = 'goog-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['GOOGLE_CLIENT_ID']
  delete process.env['GOOGLE_CLIENT_SECRET']
})

describe('the corrected quota', () => {
  it('budgets uploads from the Video Uploads bucket, not the unit quota', () => {
    // The plan carried videos.insert as 1600 units of 10,000/day — about six
    // uploads. Google's documentation now describes a separate bucket where the
    // call costs 1, with 100 per day. Six a day is a constraint you design a
    // product around; a hundred is not.
    expect(limits.publish).toEqual({ cost: 1, window: '24h', budget: 100, unit: 'requests' })
  })

  it('declares NO mediaUpload budget, because upload and publish are one call', () => {
    // A second budget here would double-count the same request and halve the
    // real allowance.
    expect('mediaUpload' in limits).toBe(false)
  })
})

describe('authorization', () => {
  it('asks for offline access AND forces consent, so a refresh token comes back', async () => {
    // Without both, a second authorization returns only an access token that
    // dies in an hour and the channel silently stops publishing the next day.
    // Invisible in testing, because the FIRST authorization does return one.
    const redirect = await youtube.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    const params = new URL(redirect.url).searchParams

    expect(params.get('access_type')).toBe('offline')
    expect(params.get('prompt')).toBe('consent')
  })

  it('refuses to build a URL when unconfigured', async () => {
    delete process.env['GOOGLE_CLIENT_ID']
    await expect(
      youtube.getAuthUrl({ redirectUri: 'https://x.test/cb', state: 's' })
    ).rejects.toThrow(/GOOGLE_CLIENT_ID/)
  })

  it('does not overwrite a stored refresh token with nothing', async () => {
    // Google does not return a refresh token on refresh. Returning undefined
    // would let a caller clear the stored one, and the channel would stop
    // refreshing a day later.
    stub([{ body: { access_token: 'new', expires_in: 3600 } }])
    const set = await youtube.refreshToken(CREDENTIAL)

    expect(set.accessToken).toBe('new')
    expect(set.refreshToken).toBeUndefined()
  })

  it('reads a dead refresh token as needing reconnection, not as misconfiguration', async () => {
    // invalid_grant is the user's to fix by reconnecting; a bad client id is
    // the operator's. Conflating them sends the wrong person to investigate.
    stub([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token revoked' } }])
    await expect(youtube.refreshToken(CREDENTIAL)).rejects.toMatchObject({ code: 'TokenExpired' })
  })
})

describe('connecting', () => {
  it('returns the channel, using its title rather than its id', async () => {
    stub([
      { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      { body: { items: [{ id: 'UC9', snippet: { title: 'Northwind', customUrl: '@northwind' } }] } },
    ])

    const accounts = await youtube.handleCallback(
      { redirectUri: 'https://x.test/cb', state: 's' },
      { code: 'c' }
    )

    expect(accounts[0]!.providerAccountId).toBe('UC9')
    expect(accounts[0]!.displayName).toBe('Northwind')
    expect(accounts[0]!.credential.refreshToken).toBe('rt')
  })

  it('says so when the Google account has no channel', async () => {
    stub([{ body: { access_token: 'at' } }, { body: { items: [] } }])
    await expect(
      youtube.handleCallback({ redirectUri: 'https://x.test/cb', state: 's' }, { code: 'c' })
    ).rejects.toThrow(/no YouTube channel/i)
  })
})

describe('publishing', () => {
  it('opens a resumable session with metadata only, then sends the bytes', async () => {
    const calls = stub([
      { body: {}, headers: { location: 'https://upload.test/session-1' } },
      { body: {} }, // the source fetch
      { body: { id: 'vid-1' } },
    ])

    const result = await youtube.publish(ACCOUNT, CREDENTIAL, payload())

    // Metadata first, so a rejection for a bad title costs no bandwidth.
    expect(calls[0]!.url).toContain('uploadType=resumable')
    expect(calls[0]!.method).toBe('POST')
    // Then the bytes, to the session URL Google handed back.
    expect(calls[2]!.url).toBe('https://upload.test/session-1')
    expect(calls[2]!.method).toBe('PUT')
    expect(result.remoteId).toBe('vid-1')
  })

  it('always sends privacyStatus, defaulting to private', async () => {
    // A missing privacyStatus is not an error and not public: it uploads
    // something nobody can see, with no indication anywhere.
    const calls = stub([
      { headers: { location: 'https://upload.test/s' } },
      {},
      { body: { id: 'v' } },
    ])
    await youtube.publish(ACCOUNT, CREDENTIAL, payload())

    const metadata = JSON.parse(calls[0]!.body as string) as { status: { privacyStatus: string } }
    expect(metadata.status.privacyStatus).toBe('private')
  })

  it('honours an explicit public request', async () => {
    const calls = stub([
      { headers: { location: 'https://upload.test/s' } },
      {},
      { body: { id: 'v' } },
    ])
    await youtube.publish(
      ACCOUNT,
      CREDENTIAL,
      payload({ platformOptions: { privacyStatus: 'public' } })
    )

    const metadata = JSON.parse(calls[0]!.body as string) as { status: { privacyStatus: string } }
    expect(metadata.status.privacyStatus).toBe('public')
  })

  it('falls back to private for an unrecognised privacy value', async () => {
    // The recoverable mistake is a video nobody saw yet.
    const calls = stub([
      { headers: { location: 'https://upload.test/s' } },
      {},
      { body: { id: 'v' } },
    ])
    await youtube.publish(ACCOUNT, CREDENTIAL, payload({ platformOptions: { privacyStatus: 'yes' } }))

    const metadata = JSON.parse(calls[0]!.body as string) as { status: { privacyStatus: string } }
    expect(metadata.status.privacyStatus).toBe('private')
  })

  it('marks the result PENDING, because processing outlives the upload', async () => {
    stub([{ headers: { location: 'https://upload.test/s' } }, {}, { body: { id: 'v' } }])
    const result = await youtube.publish(ACCOUNT, CREDENTIAL, payload())

    // A video can still fail transcoding or be blocked by Content ID after
    // this call returned success.
    expect(result.pending).toBe(true)
  })

  it('treats bytes-sent-but-no-id as ambiguous, so it reconciles', async () => {
    // A second upload would be a duplicate video, so this must never be a
    // blind retry.
    stub([{ headers: { location: 'https://upload.test/s' } }, {}, { body: {} }])
    await expect(youtube.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toMatchObject({
      code: 'ProviderDown',
    })
  })

  it('fails clearly when the session URL is missing', async () => {
    stub([{ body: {} }])
    await expect(youtube.publish(ACCOUNT, CREDENTIAL, payload())).rejects.toThrow(
      /no session URL/i
    )
  })

  it('refuses a post with no video, in the composer', () => {
    const issues = youtube.validate({ surface: 'feedVideo', text: 'words', media: [] })
    expect(issues.some((i) => i.code === 'media_required')).toBe(true)
  })
})

describe('titles', () => {
  it('takes the first line', () => {
    expect(youtubeTitle('How to roast a chicken\nA long description follows.')).toBe(
      'How to roast a chicken'
    )
  })

  it('strips angle brackets, which YouTube rejects outright', () => {
    // A rejected upload after transferring a gigabyte is an expensive way to
    // learn about a punctuation rule.
    expect(youtubeTitle('A <b>bold</b> claim')).toBe('A bbold/b claim')
  })

  it('truncates at 100 characters', () => {
    expect(youtubeTitle('x'.repeat(200))).toHaveLength(100)
  })

  it('never produces an empty title', () => {
    expect(youtubeTitle('\n\n')).toBe('Untitled')
  })
})

describe('quota errors', () => {
  it('separates a spent daily quota from a burst limit', async () => {
    // Both are 403 and they mean different things: one will not clear until
    // midnight Pacific, the other clears in seconds. Treating them alike either
    // retries pointlessly for hours or gives up on a request that would have
    // worked.
    stub([
      {
        status: 403,
        body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
      },
    ])

    const error = await youtube.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'v1').catch((e) => e)
    expect(error.code).toBe('RateLimited')
    // Retrying sooner cannot succeed, so the backoff says so.
    expect(error.options.retryAfterSeconds).toBeGreaterThan(60)
  })

  it('gives a burst limit no long backoff', async () => {
    stub([
      {
        status: 403,
        body: { error: { message: 'slow', errors: [{ reason: 'rateLimitExceeded' }] } },
      },
    ])

    const error = await youtube.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'v1').catch((e) => e)
    expect(error.code).toBe('RateLimited')
    expect(error.options.retryAfterSeconds).toBeUndefined()
  })

  it('computes the reset from the Pacific zone, not a fixed offset', () => {
    // The offset is UTC-7 or UTC-8 depending on the date, so subtracting a
    // constant is an hour wrong for half the year.
    const seconds = secondsUntilPacificMidnight(new Date('2026-08-31T12:00:00Z'))
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(86_460)
  })
})

describe('reading back', () => {
  it('walks the uploads playlist rather than searching, which costs 100x more', async () => {
    const calls = stub([
      { body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU123' } } }] } },
      {
        body: {
          items: [
            {
              snippet: {
                description: 'recent',
                publishedAt: '2026-08-31T12:00:00Z',
                resourceId: { videoId: 'v-new' },
              },
            },
          ],
        },
      },
    ])

    const posts = await youtube.retrievePosts!(
      ACCOUNT,
      CREDENTIAL,
      new Date('2026-08-31T11:00:00Z')
    )

    expect(calls[1]!.url).toContain('/playlistItems')
    expect(calls.some((c) => c.url.includes('/search'))).toBe(false)
    // The DESCRIPTION, because that is what the reconciler fingerprinted.
    expect(posts[0]!.text).toBe('recent')
  })

  it('reports a hidden like count as null, not zero', async () => {
    // A channel that hides its like count omits the field entirely.
    stub([{ body: { items: [{ statistics: { viewCount: '1200', commentCount: '3' } }] } }])
    const metrics = await youtube.fetchPostMetrics!(ACCOUNT, CREDENTIAL, 'v1')

    expect(metrics['views']).toBe(1200)
    expect(metrics['likes']).toBeNull()
  })
})
