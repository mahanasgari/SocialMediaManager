import { Redis } from 'ioredis'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AttemptLimiter, type AttemptPolicy } from './attempts.js'

const url = process.env['TEST_REDIS_URL']
const suite = url ? describe : describe.skip

if (!url) {
  console.warn('\n  [skipped] attempt limiter — set TEST_REDIS_URL (see scripts/test-db.sh)\n')
}

const redis = url ? new Redis(url) : null
afterAll(async () => {
  await redis?.quit()
})

/** Small numbers so the tests state their intent rather than counting to eight. */
const policy: AttemptPolicy = { max: 3, windowSeconds: 60, lockSeconds: 30 }

suite('attempt limiter', () => {
  let limiter: AttemptLimiter
  let id: string

  beforeEach(() => {
    limiter = new AttemptLimiter(redis!)
    // A fresh identifier per test, so one test's lockout cannot leak into the
    // next through a Redis that outlives the run.
    id = `probe-${Math.random().toString(36).slice(2)}@example.com`
  })

  it('allows an attempt when nothing has been used', async () => {
    expect((await limiter.consume('login', id, policy)).allowed).toBe(true)
  })

  it('reports how many attempts remain', async () => {
    const first = await limiter.consume('login', id, policy)
    expect(first.allowed && first.remaining).toBe(2)

    const second = await limiter.consume('login', id, policy)
    expect(second.allowed && second.remaining).toBe(1)
  })

  it('allows exactly `max` attempts, then locks', async () => {
    for (let i = 1; i <= policy.max; i++) {
      const verdict = await limiter.consume('login', id, policy)
      expect(verdict.allowed, `attempt ${i} of ${policy.max} should be allowed`).toBe(true)
    }

    const locked = await limiter.consume('login', id, policy)
    expect(locked.allowed).toBe(false)
    if (!locked.allowed) expect(locked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('does not re-arm the lock on further attempts', async () => {
    for (let i = 0; i <= policy.max; i++) await limiter.consume('login', id, policy)

    const first = await limiter.consume('login', id, policy)
    await new Promise((r) => setTimeout(r, 1100))
    const later = await limiter.consume('login', id, policy)

    expect(first.allowed).toBe(false)
    expect(later.allowed).toBe(false)
    // A lock that renews on every rejected attempt is a permanent lock: an
    // attacker still hammering the endpoint would keep the owner out forever.
    if (!first.allowed && !later.allowed) {
      expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds)
    }
  })

  it('clears the counter on success', async () => {
    await limiter.consume('login', id, policy)
    await limiter.consume('login', id, policy)
    await limiter.succeed('login', id)

    const verdict = await limiter.consume('login', id, policy)
    // Back to a full allowance. Without this, someone who mistypes twice a day
    // is eventually locked out by attempts they already recovered from.
    expect(verdict.allowed && verdict.remaining).toBe(2)
  })

  it('unlocks on success, so a password reset actually restores access', async () => {
    for (let i = 0; i <= policy.max; i++) await limiter.consume('login', id, policy)
    expect((await limiter.consume('login', id, policy)).allowed).toBe(false)

    await limiter.succeed('login', id)
    expect((await limiter.consume('login', id, policy)).allowed).toBe(true)
  })

  it('treats casing as the same account', async () => {
    // Otherwise an attacker gets a fresh budget from Alice@, ALICE@, aLiCe@ —
    // every casing of an address the database treats as one account.
    await limiter.consume('login', id.toUpperCase(), policy)
    const verdict = await limiter.consume('login', id.toLowerCase(), policy)
    expect(verdict.allowed && verdict.remaining).toBe(1)
  })

  it('ignores surrounding whitespace', async () => {
    await limiter.consume('login', `  ${id}  `, policy)
    const verdict = await limiter.consume('login', id, policy)
    expect(verdict.allowed && verdict.remaining).toBe(1)
  })

  it('keeps account and IP budgets separate', async () => {
    // They defend different attacks and must not consume one another: one
    // address ground down from many hosts, and one guess sprayed across many
    // addresses from a single host.
    await limiter.consume('login', id, policy)
    await limiter.consume('login', id, policy)

    const byIp = await limiter.consume('login-ip', '203.0.113.7', policy)
    expect(byIp.allowed && byIp.remaining).toBe(2)
  })

  it('never allows more than the limit under concurrency', async () => {
    // The reason consume() is ONE round trip. A check-then-record pair lets
    // twenty simultaneous requests each read a count below the limit and all
    // pass — exactly the shape of the attack. An earlier version of this file
    // failed this test by allowing all twenty.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('login', id, policy))
    )

    expect(results.filter((r) => r.allowed).length).toBe(policy.max)
  })

  it('locks independently per identifier', async () => {
    const other = `other-${Math.random().toString(36).slice(2)}@example.com`
    for (let i = 0; i <= policy.max; i++) await limiter.consume('login', id, policy)

    expect((await limiter.consume('login', id, policy)).allowed).toBe(false)
    // One locked account must not lock everyone else out.
    expect((await limiter.consume('login', other, policy)).allowed).toBe(true)
  })
})
