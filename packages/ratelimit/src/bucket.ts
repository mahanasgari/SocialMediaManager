// Named import, not default: ioredis is CJS, and under moduleResolution
// NodeNext the default export resolves to a namespace rather than the class.
// The named export behaves identically under both Bundler and NodeNext.
import type { Redis } from 'ioredis'
import { ACQUIRE, PENALISE, RECOVER, REFUND } from './scripts.js'

/**
 * Proactive rate budgeting.
 *
 * Consulted BEFORE every outbound provider call, by all three consumers:
 * publishing, analytics ingestion and inbox polling. Reacting to 429s is not a
 * strategy — it burns quota to discover quota, and on providers that penalise
 * sustained overage it is actively harmful. YouTube's ~6 uploads per day against
 * a 10,000-unit quota cannot be handled reactively at all: by the time an error
 * arrives, the day's budget is spent.
 *
 * Redis holds the authoritative state. A `ProviderRateState` row is written
 * occasionally for the admin console, but it is NEVER read on the hot path.
 */

export type OperationClass = 'publish' | 'mediaUpload' | 'read' | 'analytics' | 'write'
export type BudgetScope = 'app' | 'account' | 'both'

export type BudgetSpec = {
  provider: string
  accountId: string
  operation: OperationClass
  scope: BudgetScope
  /** Cost of one call. Weighted for quota-metered providers, 1 otherwise. */
  cost: number
  capacity: number
  windowMs: number
}

export type AcquireResult =
  | { granted: true; remaining: number }
  | { granted: false; waitMs: number; remaining: number }

/** Keys are namespaced so a Redis shared with BullMQ cannot collide. */
function keysFor(spec: BudgetSpec): string[] {
  const base = `rl:${spec.provider}:${spec.operation}`
  switch (spec.scope) {
    case 'app':
      return [`${base}:app`]
    case 'account':
      return [`${base}:acct:${spec.accountId}`]
    case 'both':
      // Order is fixed so two workers never take the same pair in opposite
      // sequence. The script is atomic, but a stable order keeps the debugging
      // sane and matches the refund path exactly.
      return [`${base}:app`, `${base}:acct:${spec.accountId}`]
  }
}

/**
 * Refill rate in tokens per millisecond.
 *
 * A bucket refills continuously rather than resetting on a window boundary.
 * Fixed windows let a caller spend a whole day's quota in the last second of one
 * window and the first of the next — twice the intended rate at the worst
 * possible moment.
 */
function refillPerMs(spec: BudgetSpec): number {
  return spec.capacity / spec.windowMs
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async acquire(spec: BudgetSpec, now: number = Date.now()): Promise<AcquireResult> {
    const keys = keysFor(spec)
    const ttl = Math.ceil(spec.windowMs * 2)

    const args: (string | number)[] = [spec.cost, now]
    for (const _ of keys) {
      args.push(spec.capacity, refillPerMs(spec), ttl)
    }

    const [allowed, waitMs, remaining] = (await this.redis.eval(
      ACQUIRE,
      keys.length,
      ...keys,
      ...args
    )) as [number, number, number]

    return allowed === 1
      ? { granted: true, remaining }
      : { granted: false, waitMs: Math.max(waitMs, 1), remaining }
  }

  /**
   * Return tokens acquired for work that never reached the provider.
   *
   * Called when media preparation fails after `mediaUpload` was acquired, or a
   * variant is cancelled between acquisition and publish.
   */
  async refund(spec: BudgetSpec, now: number = Date.now()): Promise<void> {
    const keys = keysFor(spec)
    const args: (string | number)[] = [spec.cost, now]
    for (const _ of keys) args.push(spec.capacity)
    await this.redis.eval(REFUND, keys.length, ...keys, ...args)
  }

  /**
   * Apply a multiplicative decrease after a provider 429.
   *
   * Note what is NOT here: no attempt count is incremented and no failure is
   * recorded. A 429 is not a failure — it is the provider telling us our
   * documented limit was wrong.
   */
  async penalise(
    spec: BudgetSpec,
    factor: number,
    recoverAfterMs: number,
    now: number = Date.now()
  ): Promise<void> {
    const keys = keysFor(spec)
    const ttl = Math.ceil(spec.windowMs * 2)
    await this.redis.eval(PENALISE, keys.length, ...keys, factor, now, ttl, recoverAfterMs)
  }

  /** Step the refill factor back toward the documented rate after a cooldown. */
  async recover(spec: BudgetSpec, step = 0.1, now: number = Date.now()): Promise<void> {
    const keys = keysFor(spec)
    await this.redis.eval(RECOVER, keys.length, ...keys, now, step)
  }

  /** For the admin console: headroom and current backoff, without touching the hot path. */
  async inspect(spec: BudgetSpec): Promise<{
    key: string
    tokens: number
    capacity: number
    factor: number
    penalisedUntil: number | null
  }[]> {
    const keys = keysFor(spec)
    const results = await Promise.all(
      keys.map(async (key) => {
        const data = await this.redis.hmget(key, 't', 'f', 'penalised_until')
        return {
          key,
          tokens: data[0] === null ? spec.capacity : Number(data[0]),
          capacity: spec.capacity,
          factor: data[1] === null ? 1 : Number(data[1]),
          penalisedUntil: data[2] === null ? null : Number(data[2]),
        }
      })
    )
    return results
  }
}

/**
 * Per-account publish mutex.
 *
 * One publish in flight per social account, always. This prevents thread and
 * reply ordering corruption where a second call overtakes the first, and it is
 * what makes reconciliation tractable — a stale IN_FLIGHT attempt can only ever
 * have one candidate.
 *
 * The lease TTL MUST exceed the maximum provider timeout, and the fencing token
 * matters: without it, a holder whose lease expired mid-call could still write
 * its result, reintroducing concurrency inside the very mechanism reconciliation
 * depends on.
 */
export class AccountMutex {
  constructor(private readonly redis: Redis) {}

  async acquire(
    provider: string,
    accountId: string,
    leaseMs: number
  ): Promise<{ token: number } | null> {
    const key = `mx:${provider}:${accountId}`
    const fenceKey = `mx:${provider}:${accountId}:fence`

    const token = await this.redis.incr(fenceKey)
    const ok = await this.redis.set(key, String(token), 'PX', leaseMs, 'NX')
    return ok === 'OK' ? { token } : null
  }

  /** True when this holder still owns the lease — check before writing a result. */
  async isHeldBy(provider: string, accountId: string, token: number): Promise<boolean> {
    const held = await this.redis.get(`mx:${provider}:${accountId}`)
    return held === String(token)
  }

  async release(provider: string, accountId: string, token: number): Promise<void> {
    const key = `mx:${provider}:${accountId}`
    // Compare-and-delete: a holder whose lease already expired must not delete a
    // lock a different worker has since taken.
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
      1,
      key,
      String(token)
    )
  }
}
