import type { Redis } from 'ioredis'

/**
 * Brute-force defence for credential endpoints.
 *
 * Separate from the provider token buckets, and deliberately so. Those shape
 * OUTBOUND traffic against somebody else's quota and refund on abort; this one
 * defends an INBOUND endpoint against an attacker, never refunds, and counts
 * attempts rather than spending a budget. Sharing the mechanism would mean one
 * set of tuning decisions serving two opposed purposes.
 *
 * Argon2id already makes each guess expensive, but that is not a substitute:
 * it also means a few hundred concurrent attempts saturate the CPU and take the
 * application down as a side effect. Rejecting before the hash is what prevents
 * the guessing AND the denial of service.
 */

export type AttemptVerdict =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number }

export type AttemptPolicy = {
  /** Attempts tolerated inside the window before the key is locked. */
  max: number
  /** How long attempts are remembered, in seconds. */
  windowSeconds: number
  /** How long a locked key stays locked, in seconds. */
  lockSeconds: number
}

/**
 * Two keys per attempt, checked together.
 *
 * PER ACCOUNT, so one address cannot be ground down however many hosts the
 * attacker controls. PER IP, so a botnet spraying one guess across thousands of
 * accounts — which no per-account counter would ever notice — is also bounded.
 *
 * Either limit alone leaves the other attack completely open.
 */
export const DEFAULT_ACCOUNT_POLICY: AttemptPolicy = {
  max: 8,
  windowSeconds: 15 * 60,
  lockSeconds: 15 * 60,
}

export const DEFAULT_IP_POLICY: AttemptPolicy = {
  // Looser, because one office behind a single NAT address is a legitimate
  // source of many sign-ins and locking them all out is its own outage.
  max: 40,
  windowSeconds: 15 * 60,
  lockSeconds: 10 * 60,
}

/**
 * Consumes an attempt and reports whether it was allowed, in ONE round trip.
 *
 * Counting on the way IN rather than recording failures on the way out is the
 * whole design. A check-then-record pair is two round trips, and twenty
 * simultaneous requests all read a count below the limit and all pass before
 * any of them records anything — which is exactly the shape of the attack this
 * defends against, so the race is not theoretical. A concurrency test caught
 * precisely that against an earlier version of this file.
 *
 * The cost is that an attempt failing for some unrelated reason still consumes
 * one. With eight per account that is a trade worth making: an attacker cannot
 * mine free attempts by opening more connections.
 */
const CONSUME = `
local key = KEYS[1]
local lock = KEYS[2]
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local lockTtl = tonumber(ARGV[3])

local lockedFor = redis.call('TTL', lock)
if lockedFor > 0 then
  -- Does NOT re-arm. A lock that renews on every rejected attempt is a
  -- permanent lock: an attacker still hammering the endpoint would keep the
  -- real owner out indefinitely.
  return {0, lockedFor}
end

local used = redis.call('INCR', key)
if used == 1 then
  -- Only on the first attempt, so the window runs from the first attempt
  -- rather than rolling forward forever as an attacker guesses slowly.
  redis.call('EXPIRE', key, window)
end

if used > max then
  redis.call('SET', lock, '1', 'EX', lockTtl)
  redis.call('DEL', key)
  return {0, lockTtl}
end

return {1, max - used}
`

export class AttemptLimiter {
  constructor(private readonly redis: Redis) {}

  /**
   * May this identifier attempt to authenticate, and record that it tried.
   *
   * Call BEFORE verifying the password. Checking afterwards still burns the
   * hash on every guess, leaving the CPU-exhaustion path wide open.
   */
  async consume(kind: string, identifier: string, policy: AttemptPolicy): Promise<AttemptVerdict> {
    const key = this.key(kind, identifier)
    const [ok, value] = (await this.redis.eval(
      CONSUME,
      2,
      key,
      `${key}:locked`,
      String(policy.max),
      String(policy.windowSeconds),
      String(policy.lockSeconds)
    )) as [number, number]

    return ok === 1
      ? { allowed: true, remaining: value }
      : { allowed: false, retryAfterSeconds: value }
  }

  /**
   * Clears the counter after a successful sign-in.
   *
   * For the ACCOUNT key. Without this, someone who mistypes twice a day is
   * eventually locked out by an accumulation of attempts they already
   * recovered from.
   */
  async succeed(kind: string, identifier: string): Promise<void> {
    const key = this.key(kind, identifier)
    await this.redis.del(key, `${key}:locked`)
  }

  /**
   * Returns one consumed attempt, without clearing the rest.
   *
   * For the IP key on a SUCCESSFUL sign-in. Clearing it outright would let an
   * attacker holding one valid account reset the whole address budget at will,
   * defeating the spray protection entirely. Leaving it alone is worse the
   * other way: an office behind a single NAT accumulates successful sign-ins
   * until everyone there is locked out, which is an outage caused by people
   * using the product correctly.
   *
   * Refunding exactly one leaves the counter measuring FAILURES from that
   * address, which is the thing worth limiting.
   *
   * Found by the end-to-end suite, which signs in repeatedly from one host and
   * locked itself out partway through.
   */
  async refund(kind: string, identifier: string): Promise<void> {
    const key = this.key(kind, identifier)
    // Guarded so a refund cannot drive the counter below zero and hand out a
    // larger budget than the policy allows.
    await this.redis.eval(
      `local n = tonumber(redis.call('GET', KEYS[1]) or '0')
       if n > 0 then redis.call('DECR', KEYS[1]) end
       return 1`,
      1,
      key
    )
  }

  /**
   * Namespaced and lowercased.
   *
   * Lowercased because an attacker would otherwise get a fresh budget from
   * `Alice@example.com`, `ALICE@example.com`, and every other casing of an
   * address the database treats as one account.
   */
  private key(kind: string, identifier: string): string {
    return `auth:${kind}:${identifier.trim().toLowerCase()}`
  }
}
