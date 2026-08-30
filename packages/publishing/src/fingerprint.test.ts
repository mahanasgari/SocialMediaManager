import { describe, expect, it } from 'vitest'
import {
  fingerprintFor,
  findMatch,
  idempotencyKey,
  normaliseForMatch,
  similarity,
  type RemoteCandidate,
} from './fingerprint.js'

const ACCOUNT = 'acct-1'
const NOW = new Date('2026-08-29T12:00:00Z')
const JUST_BEFORE = new Date('2026-08-29T11:59:30Z')

const candidate = (over: Partial<RemoteCandidate> = {}): RemoteCandidate => ({
  remoteId: 'remote-1',
  createdAt: new Date('2026-08-29T11:59:45Z'),
  text: 'Launching our new pricing today. Read more: https://example.com/pricing',
  mediaCount: 0,
  ...over,
})

describe('idempotency key', () => {
  it('is stable across retries of identical content', () => {
    expect(idempotencyKey('v1', 'hello', 0)).toBe(idempotencyKey('v1', 'hello', 0))
  })

  it('differs per variant, so two channels are never conflated', () => {
    expect(idempotencyKey('v1', 'hello', 0)).not.toBe(idempotencyKey('v2', 'hello', 0))
  })

  it('changes when the content changes', () => {
    expect(idempotencyKey('v1', 'hello', 0)).not.toBe(idempotencyKey('v1', 'hello!', 0))
  })

  it('changes when media is added', () => {
    expect(idempotencyKey('v1', 'hello', 0)).not.toBe(idempotencyKey('v1', 'hello', 1))
  })

  it('ignores whitespace-only differences', () => {
    // Trailing whitespace should not make a retry look like new content.
    expect(idempotencyKey('v1', 'hello  world ', 0)).toBe(idempotencyKey('v1', 'hello world', 0))
  })
})

describe('normalisation survives what providers actually do', () => {
  it('drops URLs, because shorteners replace them wholesale', () => {
    // X rewrites every link to a t.co shortlink. Keeping the URL in the
    // fingerprint would guarantee a miss.
    expect(normaliseForMatch('See https://example.com/very/long')).toBe('see')
  })

  it('collapses whitespace', () => {
    expect(normaliseForMatch('a   b\n\nc')).toBe('a b c')
  })

  it('folds unicode compatibility forms', () => {
    // NFKC folds the fullwidth and ligature forms some clients emit.
    expect(normaliseForMatch('ﬁle')).toBe('file')
    expect(normaliseForMatch('Ｈello')).toBe('hello')
  })

  it('folds case', () => {
    expect(normaliseForMatch('Hello World')).toBe(normaliseForMatch('hello world'))
  })

  it('truncates, because truncation is itself a provider mutation', () => {
    expect(normaliseForMatch('x'.repeat(500))).toHaveLength(120)
  })
})

describe('similarity', () => {
  it('is 1 for identical strings', () => {
    expect(similarity('hello world', 'hello world')).toBe(1)
  })

  it('stays high when a suffix is truncated', () => {
    expect(similarity('launching our new pricing today', 'launching our new pricing')).toBeGreaterThan(0.85)
  })

  it('is low for unrelated text', () => {
    expect(similarity('launching our new pricing', 'weekend maintenance window')).toBeLessThan(0.4)
  })

  it('handles very short strings without dividing by zero', () => {
    expect(similarity('a', 'a')).toBe(1)
    expect(similarity('a', 'b')).toBe(0)
    expect(similarity('', '')).toBe(1)
  })
})

describe('reconciliation matching', () => {
  const original = 'Launching our new pricing today. Read more: https://example.com/pricing'
  const fp = fingerprintFor(original, 0, ACCOUNT)

  it('finds a post the provider rewrote the links in', () => {
    // The exact case that matters: we sent a full URL, X stored a t.co link.
    // Exact matching would miss it and republish.
    const rewritten = candidate({
      text: 'Launching our new pricing today. Read more: https://t.co/aB3xY9',
    })
    expect(findMatch(fp, [rewritten], JUST_BEFORE, { now: NOW })?.remoteId).toBe('remote-1')
  })

  it('finds a post the provider truncated', () => {
    const truncated = candidate({ text: 'Launching our new pricing today. Read mo…' })
    expect(findMatch(fp, [truncated], JUST_BEFORE, { now: NOW })).not.toBeNull()
  })

  it('finds a post whose whitespace was trimmed', () => {
    const trimmed = candidate({ text: original.replace(/\. /g, '.  ') + '   ' })
    expect(findMatch(fp, [trimmed], JUST_BEFORE, { now: NOW })).not.toBeNull()
  })

  it('does NOT match a different post from the same account', () => {
    // A false positive here is worse than a miss: it marks an unpublished post
    // as published, and the content never goes out at all.
    const other = candidate({ text: 'Scheduled maintenance this weekend, 02:00–04:00 UTC.' })
    expect(findMatch(fp, [other], JUST_BEFORE, { now: NOW })).toBeNull()
  })

  it('does not match when the media count differs', () => {
    // Structural: a provider may rewrite text but will not silently change how
    // many images are attached.
    const withImage = candidate({ mediaCount: 2 })
    expect(findMatch(fp, [withImage], JUST_BEFORE, { now: NOW })).toBeNull()
  })

  it('ignores posts from outside the time window', () => {
    const old = candidate({ createdAt: new Date('2026-08-28T12:00:00Z') })
    expect(findMatch(fp, [old], JUST_BEFORE, { now: NOW })).toBeNull()
  })

  it('picks the closest candidate when several are similar', () => {
    const close = candidate({ remoteId: 'exact', text: original })
    const looser = candidate({ remoteId: 'looser', text: 'Launching our new pricing' })
    expect(findMatch(fp, [looser, close], JUST_BEFORE, { now: NOW })?.remoteId).toBe('exact')
  })

  it('returns null on no candidates — the SAFE answer', () => {
    // Null means "we do not know", and the caller escalates to NEEDS_REVIEW
    // rather than retrying blind.
    expect(findMatch(fp, [], JUST_BEFORE, { now: NOW })).toBeNull()
  })

  it('a stricter threshold refuses a marginal match', () => {
    const marginal = candidate({ text: 'Launching pricing' })
    expect(findMatch(fp, [marginal], JUST_BEFORE, { now: NOW, threshold: 0.99 })).toBeNull()
  })
})
