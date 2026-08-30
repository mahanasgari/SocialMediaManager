import { describe, expect, it } from 'vitest'
import {
  hostOf,
  normaliseInstance,
  stripHtml,
  toProviderError,
  visibilityOf,
} from './adapter.js'
import { capabilities, text } from './capabilities.js'
import { validateText } from '../capabilities/index.js'

describe('instance addresses', () => {
  it('accepts a bare hostname, which is what people actually type', () => {
    expect(normaliseInstance('mastodon.social')).toBe('https://mastodon.social')
  })

  it('accepts a full URL', () => {
    expect(normaliseInstance('https://mastodon.social')).toBe('https://mastodon.social')
  })

  it('drops a path and trailing slash, keeping only the origin', () => {
    expect(normaliseInstance('https://mastodon.social/@alice')).toBe('https://mastodon.social')
    expect(normaliseInstance('mastodon.social/')).toBe('https://mastodon.social')
  })

  it('preserves a non-default port, which self-hosted instances use', () => {
    expect(normaliseInstance('https://social.example.com:8443')).toBe(
      'https://social.example.com:8443'
    )
  })

  it('REFUSES plain http', () => {
    // The access token would cross the wire in clear text. There is no version
    // of that worth supporting, so it fails rather than silently upgrading.
    expect(() => normaliseInstance('http://insecure.example')).toThrow(/https/)
  })

  it('refuses an empty or unusable address with a message naming an example', () => {
    expect(() => normaliseInstance('')).toThrow(/mastodon\.social/)
    expect(() => normaliseInstance(undefined)).toThrow(/required/)
  })

  it('extracts the host for building a handle', () => {
    expect(hostOf('https://mastodon.social')).toBe('mastodon.social')
    expect(hostOf('https://social.example.com:8443')).toBe('social.example.com:8443')
  })
})

describe('visibility', () => {
  it('passes through the four Mastodon accepts', () => {
    for (const v of ['public', 'unlisted', 'private', 'direct']) {
      expect(visibilityOf(v)).toBe(v)
    }
  })

  it('falls back to public for anything else', () => {
    // Sending an unrecognised value would be a 422 at publish time. Coercing
    // here means an unknown option costs a wrong-but-safe visibility rather
    // than a failed post.
    expect(visibilityOf('followers-only')).toBe('public')
    expect(visibilityOf(undefined)).toBe('public')
    expect(visibilityOf(42)).toBe('public')
  })
})

describe('stripHtml', () => {
  // Statuses come back as HTML; the fingerprint compares against what we SENT,
  // which was plain text. Without this, reconciliation never matches and the
  // duplicate the mechanism exists to prevent is exactly what gets created.
  it('unwraps a paragraph', () => {
    expect(stripHtml('<p>Hello there</p>')).toBe('Hello there')
  })

  it('turns breaks and paragraph ends into newlines', () => {
    expect(stripHtml('<p>one<br />two</p><p>three</p>')).toBe('one\ntwo\n\nthree')
  })

  it('strips a link but keeps its visible text', () => {
    expect(stripHtml('<p>see <a href="https://example.com">example.com</a></p>')).toBe(
      'see example.com'
    )
  })

  it('decodes entities, with &amp; last so &amp;lt; does not become <', () => {
    expect(stripHtml('<p>Tom &amp; Jerry&#39;s &quot;show&quot;</p>')).toBe(
      'Tom & Jerry\'s "show"'
    )
    expect(stripHtml('<p>&amp;lt;</p>')).toBe('&lt;')
  })

  it('leaves plain text alone', () => {
    expect(stripHtml('already plain')).toBe('already plain')
  })
})

describe('error mapping', () => {
  it('maps 429 and reads x-ratelimit-reset for the wait', () => {
    const reset = new Date(Date.now() + 60_000).toISOString()
    const error = toProviderError(429, {}, 'posting', new Headers({ 'x-ratelimit-reset': reset }))
    expect(error.code).toBe('RateLimited')
    expect(error.retryable).toBe(true)
    expect(error.options.retryAfterSeconds).toBeGreaterThan(50)
  })

  it('still maps 429 with no reset header', () => {
    expect(toProviderError(429, {}, 'posting').code).toBe('RateLimited')
  })

  it('maps 401 to TokenExpired with a recovery instruction', () => {
    const error = toProviderError(401, { error: 'The access token is invalid' }, 'posting')
    expect(error.code).toBe('TokenExpired')
    expect(error.message).toMatch(/[Rr]econnect/)
  })

  it('maps 422 to ContentRejected, keeping the reason', () => {
    const error = toProviderError(
      422,
      { error: 'Validation failed: Text character limit of 500 exceeded' },
      'posting'
    )
    expect(error.code).toBe('ContentRejected')
    expect(error.message).toContain('500')
  })

  it('maps 413 to InvalidMedia and mentions that instance limits vary', () => {
    const error = toProviderError(413, {}, 'uploading media')
    expect(error.code).toBe('InvalidMedia')
    expect(error.message).toMatch(/vary/)
  })

  it('treats 5xx as retryable rather than permanent', () => {
    const error = toProviderError(503, {}, 'posting')
    expect(error.code).toBe('ProviderDown')
    expect(error.retryable).toBe(true)
  })

  it('prefers error_description over error when both are present', () => {
    const error = toProviderError(
      400,
      { error: 'invalid_grant', error_description: 'The authorization code has expired' },
      'exchanging a code'
    )
    expect(error.message).toContain('authorization code has expired')
  })

  it('PRESERVES an unrecognised error rather than replacing it', () => {
    const error = toProviderError(400, { error: 'SOMETHING_NEW' }, 'posting')
    expect(error.code).toBe('PermanentFailure')
    expect(error.message).toContain('SOMETHING_NEW')
  })
})

describe('link handling', () => {
  const profile = text.feed!

  it('counts every URL as 23 characters, however long it really is', () => {
    // A naive character count would reject posts the instance accepts. The URL
    // below is 120 characters and costs 23.
    const url = 'https://example.com/' + 'a'.repeat(100)
    const issues = validateText(
      { text: `Read this: ${url}`, media: [], surface: 'feed' },
      profile,
      'Mastodon'
    )
    expect(issues).toEqual([])
  })

  it('still rejects genuinely over-long text', () => {
    const issues = validateText(
      { text: 'x'.repeat(600), media: [], surface: 'feed' },
      profile,
      'Mastodon'
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('text_too_long')
  })

  it('validates against a raised instance limit when one is known', () => {
    // 500 is a DEFAULT, not a rule. Instances routinely raise it, and enforcing
    // 500 against an instance allowing 5000 is wrong in the direction users
    // notice most.
    const issues = validateText(
      { text: 'x'.repeat(600), media: [], surface: 'feed' },
      { ...profile, maxLength: 5000 },
      'Mastodon (fosstodon.org)'
    )
    expect(issues).toEqual([])
  })
})

describe('capability honesty', () => {
  it('claims read-back, which is what makes reconciliation possible here', () => {
    expect(capabilities.retrievePosts).toBe(true)
  })

  it('does not claim DMs', () => {
    // Direct-visibility statuses exist, but they are not a DM system, and
    // modelling them as one would put a conversation UI on top of something
    // that does not behave like a conversation.
    expect(capabilities.dm).toBe(false)
    expect(capabilities.conversations).toBe(false)
  })

  it('does not claim signed inbound webhooks', () => {
    // Streaming exists, but it is a socket, not a signed HTTP callback, and the
    // inbound receiver would have nothing to verify.
    expect(capabilities.webhooks).toBe(false)
  })

  it('does not delegate scheduling to the instance', () => {
    // Mastodon has scheduled_at, but the calendar, the approval gate, the
    // catch-up window and MISSED all live here. Handing a status to the
    // instance would put half the schedule somewhere we cannot edit or report.
    expect(capabilities.draftSupport).toBe(false)
  })
})
