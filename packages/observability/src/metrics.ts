import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client'

/**
 * Metrics, in the one format every operator already has a scraper for.
 *
 * The admin console answers "is this workspace healthy?" for a person looking
 * at a screen. This answers "wake me at 3am" for a machine that is not looking
 * at anything, and the two are not substitutes: a dashboard nobody is watching
 * during an incident is a dashboard that did not exist.
 *
 * What is measured here is chosen from what has actually gone wrong in this
 * system rather than from what is easy to count. Request rate is easy and
 * nearly useless; "a variant has been PUBLISHING for six minutes" is neither.
 *
 * `prom-client` rather than a hand-rolled registry, for one reason worth
 * naming: `collectDefaultMetrics` reports event-loop lag. The characteristic
 * failure of this worker is a transcode pinning the loop while every other job
 * silently stops, and that is invisible in every application-level number here —
 * publishes simply stop arriving, which looks identical to nobody posting.
 */

export const registry = new Registry()

collectDefaultMetrics({ register: registry, prefix: 'smm_' })

// -- Publishing --------------------------------------------------------------

/**
 * Outcomes, by provider and result.
 *
 * Labelled by outcome rather than split into success/failure counters, so the
 * ratio is one query. `reconciled` is broken out from `published` on purpose:
 * both mean the post is live, but a rising reconciled rate means workers are
 * dying mid-publish, and collapsing them hides the only signal that says so.
 */
export const publishOutcomes = new Counter({
  name: 'smm_publish_outcomes_total',
  help: 'Publish attempts by provider and outcome.',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
})

export const publishDuration = new Histogram({
  name: 'smm_publish_duration_seconds',
  help: 'Time from claiming a variant to a final status.',
  labelNames: ['provider'] as const,
  // Buckets chosen for what these calls actually do. A publish carrying media
  // is a multi-second operation and the default buckets top out at 10s, which
  // would put every video upload in +Inf — the exact requests worth measuring.
  buckets: [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
})

/**
 * How late a post went out, against the time it was scheduled for.
 *
 * The number a customer notices, and one an average would hide: a handful of
 * posts an hour late matters even when the mean is two seconds.
 */
export const publishLateness = new Histogram({
  name: 'smm_publish_lateness_seconds',
  help: 'Delay between scheduledAt and actual publication.',
  buckets: [1, 5, 15, 30, 60, 300, 900, 1800, 3600],
  registers: [registry],
})

/**
 * Publishes left in flight by a process that did not come back.
 *
 * Not zero is not an emergency — the sweep handles it. Persistently not zero
 * means the sweep is not handling it, which is the top-ranked risk in this
 * system arriving quietly.
 */
export const interruptedPublishes = new Gauge({
  name: 'smm_publishes_interrupted',
  help: 'Publish attempts still IN_FLIGHT past the staleness threshold.',
  registers: [registry],
})

export const recoveryOutcomes = new Counter({
  name: 'smm_recovery_outcomes_total',
  help: 'Interrupted publishes resolved by the crash reconciler, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

// -- Scheduling --------------------------------------------------------------

/**
 * Posts whose time has passed that are still not out.
 *
 * The single most important number here. A healthy install sits at zero except
 * for the seconds between a tick and its publish, so any sustained value is a
 * scheduler that has stopped — which otherwise looks exactly like a quiet week.
 */
export const overdueVariants = new Gauge({
  name: 'smm_variants_overdue',
  help: 'Scheduled or queued variants whose scheduled time has passed.',
  registers: [registry],
})

export const oldestOverdueSeconds = new Gauge({
  name: 'smm_oldest_overdue_seconds',
  help: 'Age of the oldest overdue variant. Zero when none are overdue.',
  registers: [registry],
})

export const variantsAwaitingReview = new Gauge({
  name: 'smm_variants_needing_review',
  help: 'Variants a human must decide about — usually an unconfirmable publish.',
  registers: [registry],
})

export const tickDuration = new Histogram({
  name: 'smm_worker_tick_seconds',
  help: 'Wall time of one worker tick, by phase.',
  labelNames: ['phase'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [registry],
})

// -- Rate limiting -----------------------------------------------------------

/**
 * Budget denials, separated from provider 429s.
 *
 * These two look alike on a graph and mean opposite things. A local denial is
 * the budget doing its job; a provider 429 is our documented limit being wrong.
 * One counter for both would make the distinction the whole rate-limit design
 * rests on unmeasurable.
 */
export const budgetDenials = new Counter({
  name: 'smm_budget_denials_total',
  help: 'Operations deferred by our own token bucket before any call was made.',
  labelNames: ['provider', 'operation'] as const,
  registers: [registry],
})

export const providerRateLimits = new Counter({
  name: 'smm_provider_rate_limits_total',
  help: 'Provider 429s received — our documented budget was wrong.',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const signInAttemptsBlocked = new Counter({
  name: 'smm_signin_attempts_blocked_total',
  help: 'Sign-in attempts refused by the brute-force limiter, by kind.',
  labelNames: ['kind'] as const,
  registers: [registry],
})

// -- Inbound -----------------------------------------------------------------

export const inboundEvents = new Counter({
  name: 'smm_inbound_events_total',
  help: 'Inbound provider events, by provider and disposition.',
  labelNames: ['provider', 'disposition'] as const,
  registers: [registry],
})

// -- HTTP --------------------------------------------------------------------

/**
 * Request duration, labelled by ROUTE not by URL.
 *
 * `/api/v1/posts/:id`, never `/api/v1/posts/01a0…`. A label whose values are
 * unbounded gives every request its own time series and takes the monitoring
 * system down — the classic way an observability change causes the outage it
 * was added to catch.
 */
export const httpDuration = new Histogram({
  name: 'smm_http_request_duration_seconds',
  help: 'API request duration by route, method and status class.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

// -- Export ------------------------------------------------------------------

export const exportJobs = new Counter({
  name: 'smm_export_jobs_total',
  help: 'Data export jobs by kind and outcome.',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
})

/** The Prometheus text exposition of everything above. */
export async function scrape(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType }
}

/** Test helper. Resets every value without discarding the definitions. */
export function resetMetrics(): void {
  registry.resetMetrics()
}
