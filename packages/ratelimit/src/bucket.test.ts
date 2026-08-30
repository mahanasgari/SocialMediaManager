import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import { AccountMutex, RateLimiter, type BudgetSpec } from './bucket.js'

/**
 * These run against a REAL Redis, not a mock.
 *
 * The properties under test — atomicity across two keys, no over-issue under
 * concurrency — are properties of Redis script execution. A mock would assert
 * that our code calls eval, which is exactly the part that cannot be wrong in an
 * interesting way.
 */

const url = process.env['TEST_REDIS_URL']
const suite = url ? describe : describe.skip
if (!url) {
  console.warn('\n  [skipped] rate limiter suite — set TEST_REDIS_URL (see scripts/test-db.sh)\n')
}

let redis: Redis
let limiter: RateLimiter

const spec = (over: Partial<BudgetSpec> = {}): BudgetSpec => ({
  provider: 'test',
  accountId: 'acct-1',
  operation: 'publish',
  scope: 'account',
  cost: 1,
  capacity: 10,
  windowMs: 60_000,
  ...over,
})

afterAll(async () => {
  await redis?.quit()
})

suite('rate limiter', () => {
  beforeEach(async () => {
    redis ??= new Redis(url!)
    limiter = new RateLimiter(redis)
    const keys = await redis.keys('rl:test:*')
    if (keys.length) await redis.del(...keys)
  })

  it('grants while tokens remain and reports what is left', async () => {
    const result = await limiter.acquire(spec())
    expect(result.granted).toBe(true)
    expect(result.remaining).toBe(9)
  })

  it('denies once the budget is exhausted', async () => {
    const s = spec({ capacity: 3 })
    for (let i = 0; i < 3; i++) expect((await limiter.acquire(s)).granted).toBe(true)

    const denied = await limiter.acquire(s)
    expect(denied.granted).toBe(false)
    // A wait time, not just a refusal: the caller reschedules by it rather than
    // guessing or hammering.
    expect(denied.granted === false && denied.waitMs).toBeGreaterThan(0)
  })

  it('charges weighted cost for quota-metered providers', async () => {
    // YouTube's videos.insert costs 1600 units, not one request.
    const s = spec({ capacity: 10_000, cost: 1600 })
    const first = await limiter.acquire(s)
    expect(first.granted).toBe(true)
    expect(first.remaining).toBe(8400)

    for (let i = 0; i < 5; i++) await limiter.acquire(s)
    // 6 uploads is 9600 of 10000 — the 7th must not fit.
    expect((await limiter.acquire(s)).granted).toBe(false)
  })

  it('refills continuously rather than resetting on a window boundary', async () => {
    const s = spec({ capacity: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) await limiter.acquire(s)
    expect((await limiter.acquire(s)).granted).toBe(false)

    // A fixed window would let a caller spend a full budget at the end of one
    // window and again at the start of the next — twice the intended rate at
    // the worst possible moment.
    const later = await limiter.acquire(s, Date.now() + 500)
    expect(later.granted).toBe(true)
  })

  it('never over-issues under concurrent acquisition', async () => {
    // The reason every operation is a Lua script. A read-then-write from the
    // client lets two workers both see "1 left" and both proceed.
    const s = spec({ capacity: 20 })
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.acquire(s)))
    expect(results.filter((r) => r.granted)).toHaveLength(20)
  })

  describe("scope 'both'", () => {
    it('debits the app and account buckets together', async () => {
      const s = spec({ scope: 'both', capacity: 5 })
      await limiter.acquire(s)
      const state = await limiter.inspect(s)
      expect(state).toHaveLength(2)
      expect(state.every((b) => b.tokens === 4)).toBe(true)
    })

    it('does NOT debit the app bucket when the account bucket cannot pay', async () => {
      // The leak this prevents: acquiring sequentially succeeds on the app
      // bucket, fails on the account bucket, and the app token is gone — never
      // spent at the provider and never refunded.
      const s = spec({ scope: 'both', capacity: 2 })
      await limiter.acquire(s)
      await limiter.acquire(s)

      const before = await limiter.inspect(s)
      const denied = await limiter.acquire(s)
      const after = await limiter.inspect(s)

      expect(denied.granted).toBe(false)
      // Not equality: buckets refill continuously, so a few milliseconds between
      // the two reads legitimately adds a sliver of a token. The property that
      // matters is that a DENIAL never debits — tokens may only go up.
      after.forEach((bucket, i) => {
        expect(bucket.tokens).toBeGreaterThanOrEqual(before[i]!.tokens)
      })
    })

    it('shares the app bucket across accounts', async () => {
      const a = spec({ scope: 'both', accountId: 'acct-a', capacity: 3 })
      const b = spec({ scope: 'both', accountId: 'acct-b', capacity: 3 })
      await limiter.acquire(a)
      await limiter.acquire(a)
      await limiter.acquire(a)

      // acct-b has its own account bucket but the shared app bucket is spent.
      expect((await limiter.acquire(b)).granted).toBe(false)
    })
  })

  describe('refund', () => {
    it('returns tokens for work that never reached the provider', async () => {
      // Acquired before a transcode that then failed. On YouTube's ~6/day,
      // silently losing one is losing a whole upload.
      const s = spec({ capacity: 5 })
      await limiter.acquire(s)
      expect((await limiter.inspect(s))[0]?.tokens).toBe(4)

      await limiter.refund(s)
      expect((await limiter.inspect(s))[0]?.tokens).toBe(5)
    })

    it('cannot mint tokens beyond capacity', async () => {
      const s = spec({ capacity: 5 })
      await limiter.acquire(s)
      await limiter.refund(s)
      await limiter.refund(s)
      expect((await limiter.inspect(s))[0]?.tokens).toBe(5)
    })

    it('refunds both buckets under scope both', async () => {
      const s = spec({ scope: 'both', capacity: 5 })
      await limiter.acquire(s)
      await limiter.refund(s)
      expect((await limiter.inspect(s)).every((b) => b.tokens === 5)).toBe(true)
    })
  })

  describe('adaptive correction', () => {
    it('halves the refill rate after a 429', async () => {
      const s = spec({ capacity: 10, windowMs: 1000 })
      await limiter.acquire(s)
      await limiter.penalise(s, 0.5, 15_000)

      const state = await limiter.inspect(s)
      expect(state[0]?.factor).toBe(0.5)
      expect(state[0]?.penalisedUntil).toBeGreaterThan(Date.now())
    })

    it('a penalised bucket refills at the reduced rate', async () => {
      const s = spec({ capacity: 10, windowMs: 1000 })
      for (let i = 0; i < 10; i++) await limiter.acquire(s)
      await limiter.penalise(s, 0.5, 15_000)

      // 500ms would restore 5 tokens at full rate; at half rate it restores 2.5,
      // so a cost of 3 must still be refused.
      const result = await limiter.acquire({ ...s, cost: 3 }, Date.now() + 500)
      expect(result.granted).toBe(false)
    })

    it('compounds on repeated 429s but never reaches zero', async () => {
      const s = spec()
      for (let i = 0; i < 20; i++) await limiter.penalise(s, 0.5, 1)
      const state = await limiter.inspect(s)
      // A zero refill rate would be a permanently stuck bucket.
      expect(state[0]?.factor).toBeGreaterThan(0)
      expect(state[0]?.factor).toBeLessThan(0.1)
    })

    it('recovers toward the documented rate only after the cooldown', async () => {
      const s = spec()
      await limiter.penalise(s, 0.5, 10_000)

      await limiter.recover(s, 0.1, Date.now())
      expect((await limiter.inspect(s))[0]?.factor).toBe(0.5)

      await limiter.recover(s, 0.1, Date.now() + 11_000)
      expect((await limiter.inspect(s))[0]?.factor).toBeCloseTo(0.6, 5)
    })

    it('never recovers past the documented rate', async () => {
      const s = spec()
      await limiter.penalise(s, 0.9, 1)
      for (let i = 0; i < 20; i++) await limiter.recover(s, 0.5, Date.now() + 10_000)
      expect((await limiter.inspect(s))[0]?.factor).toBe(1)
    })
  })
})

suite('per-account publish mutex', () => {
  let mutex: AccountMutex

  beforeEach(async () => {
    redis ??= new Redis(url!)
    mutex = new AccountMutex(redis)
    const keys = await redis.keys('mx:test:*')
    if (keys.length) await redis.del(...keys)
  })

  it('admits one holder at a time', async () => {
    const first = await mutex.acquire('test', 'acct-1', 5000)
    const second = await mutex.acquire('test', 'acct-1', 5000)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('does not serialise different accounts', async () => {
    expect(await mutex.acquire('test', 'acct-1', 5000)).not.toBeNull()
    expect(await mutex.acquire('test', 'acct-2', 5000)).not.toBeNull()
  })

  it('issues a monotonic fencing token', async () => {
    const first = await mutex.acquire('test', 'acct-1', 50)
    await mutex.release('test', 'acct-1', first!.token)
    const second = await mutex.acquire('test', 'acct-1', 50)
    expect(second!.token).toBeGreaterThan(first!.token)
  })

  it('an expired holder can detect it no longer owns the lease', async () => {
    // Without this check, a holder whose lease expired mid-call could still
    // write its result — reintroducing concurrency inside the very mechanism
    // reconciliation depends on.
    const first = await mutex.acquire('test', 'acct-1', 40)
    await new Promise((r) => setTimeout(r, 90))

    const second = await mutex.acquire('test', 'acct-1', 5000)
    expect(second).not.toBeNull()
    expect(await mutex.isHeldBy('test', 'acct-1', first!.token)).toBe(false)
    expect(await mutex.isHeldBy('test', 'acct-1', second!.token)).toBe(true)
  })

  it('a stale holder cannot release a lock someone else now holds', async () => {
    const first = await mutex.acquire('test', 'acct-1', 40)
    await new Promise((r) => setTimeout(r, 90))
    const second = await mutex.acquire('test', 'acct-1', 5000)

    await mutex.release('test', 'acct-1', first!.token)

    expect(await mutex.isHeldBy('test', 'acct-1', second!.token)).toBe(true)
  })
})
