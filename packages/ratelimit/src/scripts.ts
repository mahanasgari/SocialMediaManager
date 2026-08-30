/**
 * Lua scripts for the distributed token bucket.
 *
 * EVERYTHING is Lua because a token bucket read-then-write from the client is
 * not atomic: two workers can both read "1 token left" and both proceed. Redis
 * executes a script as a single unit, so the check and the decrement cannot be
 * interleaved.
 *
 * The multi-key form matters just as much. When a provider meters BOTH per app
 * and per account, acquiring sequentially can succeed on the first bucket and
 * fail on the second — leaking a token from the first, which is then never
 * spent and never refunded. One script checks every bucket before decrementing
 * any of them.
 */

/**
 * Acquire from 1..N buckets atomically.
 *
 * KEYS  : one per bucket
 * ARGV  : cost, now_ms, then per bucket → capacity, refill_per_ms, ttl_ms
 * Returns: { allowed (0|1), wait_ms, remaining_in_tightest_bucket }
 *
 * State per bucket is a hash: `t` tokens (float), `ts` last refill ms,
 * `f` refill factor (adaptive correction; 1 = documented rate).
 */
export const ACQUIRE = `
local cost   = tonumber(ARGV[1])
local now    = tonumber(ARGV[2])
local n      = #KEYS

local states = {}

-- PASS 1: refill every bucket and check whether ALL can pay. Nothing is written
-- yet, so a failure on the last bucket cannot leave the first one debited.
local allowed = 1
local wait_ms = 0
local tightest = math.huge

for i = 1, n do
  local base    = 2 + (i - 1) * 3
  local cap     = tonumber(ARGV[base + 1])
  local refill  = tonumber(ARGV[base + 2])
  local ttl     = tonumber(ARGV[base + 3])

  local data   = redis.call('HMGET', KEYS[i], 't', 'ts', 'f')
  local tokens = tonumber(data[1])
  local ts     = tonumber(data[2])
  local factor = tonumber(data[3]) or 1

  if tokens == nil then
    tokens = cap
    ts = now
  end

  local elapsed = math.max(0, now - ts)
  tokens = math.min(cap, tokens + elapsed * refill * factor)

  states[i] = { tokens = tokens, cap = cap, refill = refill * factor, ttl = ttl }

  if tokens < cost then
    allowed = 0
    local deficit = cost - tokens
    local rate = states[i].refill
    -- A zero refill rate means the bucket only resets on its window boundary;
    -- report the whole TTL rather than dividing by zero.
    local this_wait = rate > 0 and math.ceil(deficit / rate) or ttl
    if this_wait > wait_ms then wait_ms = this_wait end
  end

  if tokens < tightest then tightest = tokens end
end

-- PASS 2: only now, and only if every bucket can pay, debit them all.
for i = 1, n do
  local s = states[i]
  local tokens = s.tokens
  if allowed == 1 then tokens = tokens - cost end
  redis.call('HSET', KEYS[i], 't', tokens, 'ts', now)
  redis.call('PEXPIRE', KEYS[i], s.ttl)
end

if allowed == 1 then tightest = tightest - cost end
return { allowed, wait_ms, math.floor(tightest) }
`

/**
 * Return unspent tokens.
 *
 * Budget is acquired before media preparation; if the transcode then fails, or
 * the variant is cancelled, those tokens were never spent at the provider.
 * On YouTube's ~6 uploads a day, silently losing one is losing a whole upload.
 */
export const REFUND = `
local cost = tonumber(ARGV[1])
local now  = tonumber(ARGV[2])

for i = 1, #KEYS do
  local cap = tonumber(ARGV[2 + i])
  local data = redis.call('HMGET', KEYS[i], 't', 'ts')
  local tokens = tonumber(data[1])
  if tokens ~= nil then
    -- Capped, so a double refund cannot mint tokens that never existed.
    redis.call('HSET', KEYS[i], 't', math.min(cap, tokens + cost), 'ts', now)
  end
end
return 1
`

/**
 * Multiplicative decrease after a provider 429.
 *
 * Documented limits are frequently wrong, and the provider's own 429 is the only
 * authoritative signal. Halving the refill rate for a cooldown makes the bucket
 * converge on reality instead of arguing with it.
 */
export const PENALISE = `
local factor    = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])
local ttl       = tonumber(ARGV[3])
local recover   = tonumber(ARGV[4])

for i = 1, #KEYS do
  local current = tonumber(redis.call('HGET', KEYS[i], 'f')) or 1
  local next_factor = math.max(0.05, current * factor)
  redis.call('HSET', KEYS[i], 'f', next_factor, 'ts', now, 'penalised_until', now + recover)
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return 1
`

/** Linear restoration toward the documented rate once the cooldown has passed. */
export const RECOVER = `
local now  = tonumber(ARGV[1])
local step = tonumber(ARGV[2])

for i = 1, #KEYS do
  local data = redis.call('HMGET', KEYS[i], 'f', 'penalised_until')
  local factor = tonumber(data[1])
  local until_ms = tonumber(data[2])
  if factor ~= nil and factor < 1 and until_ms ~= nil and now >= until_ms then
    redis.call('HSET', KEYS[i], 'f', math.min(1, factor + step))
  end
end
return 1
`
