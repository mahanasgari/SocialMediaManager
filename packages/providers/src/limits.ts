/**
 * Rate budget declarations.
 *
 * A connector arrives with its limits or it does not arrive — CI gate G2 fails
 * otherwise. Reacting to 429s is not a rate-limit strategy: it burns quota to
 * discover quota, and on providers that penalise sustained overage it is
 * actively harmful. YouTube's ~6 uploads per day against a 10,000-unit quota
 * cannot be handled reactively at all, because by the time an error arrives the
 * day's budget is already spent.
 */

/**
 * Operation classes.
 *
 * Separate classes matter because they draw on different quotas and cost
 * different amounts. Budget is acquired per OPERATION, not per job: a single
 * acquisition before media preparation would hold a `publish` token across a
 * multi-minute transcode while never spending `mediaUpload` at all.
 */
export const OPERATION_CLASSES = ['publish', 'mediaUpload', 'read', 'analytics', 'write'] as const
export type OperationClass = (typeof OPERATION_CLASSES)[number]

export type BudgetUnit = 'requests' | 'quota'

export type OperationBudget = {
  /** Cost of one call. Weighted for quota-metered providers, 1 for request-metered. */
  cost: number
  /** e.g. '24h', '15m', '1h'. */
  window: string
  budget: number
  unit: BudgetUnit
}

/**
 * Whether a bucket is per application or per connected account.
 *
 * Explicit because BOTH mistakes are real: per-app budgets applied per-account
 * exhaust the app quota, and per-account budgets applied per-app throttle
 * everyone needlessly. With `'both'`, a single Lua script checks and decrements
 * both buckets atomically — never two sequential acquisitions, which can
 * partially succeed and leak tokens.
 */
export type BudgetScope = 'app' | 'account' | 'both'

export type ProviderLimits = {
  scope: BudgetScope
  concurrency: {
    /**
     * Publishes in flight per account. Should be 1 almost everywhere: it
     * prevents thread and reply ordering corruption where a second call can
     * overtake the first, and it makes reconciliation tractable, because a stale
     * IN_FLIGHT attempt can then only ever have one candidate.
     */
    perAccount: number
    perProvider: number
  }
  onProviderLimit: {
    honorRetryAfter: boolean
    /** Multiplicative decrease applied to the refill rate on a 429. */
    backoffFactor: number
    recoverAfter: string
  }
} & Partial<Record<OperationClass, OperationBudget>>

/** Parses '24h' / '15m' / '30s' to milliseconds. */
export function windowMs(window: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(window)
  if (!match) throw new Error(`Invalid window "${window}". Use forms like 30s, 15m, 24h, 7d.`)
  const value = Number(match[1])
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
  return value * multipliers[unit]
}

/**
 * Every operation class the provider declares a budget for. Used by the CI gate
 * to check that a declared capability has a budget behind it.
 */
export function declaredOperations(limits: ProviderLimits): OperationClass[] {
  return OPERATION_CLASSES.filter((op) => limits[op] !== undefined)
}
