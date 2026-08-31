import { beforeEach, describe, expect, it } from 'vitest'
import {
  budgetDenials,
  httpDuration,
  overdueVariants,
  providerRateLimits,
  publishDuration,
  publishOutcomes,
  resetMetrics,
  scrape,
} from './metrics.js'

describe('metrics', () => {
  beforeEach(() => resetMetrics())

  it('exposes Prometheus text with the right content type', async () => {
    publishOutcomes.inc({ provider: 'mastodon', outcome: 'published' })
    const { body, contentType } = await scrape()

    expect(contentType).toContain('text/plain')
    expect(body).toContain('smm_publish_outcomes_total')
    expect(body).toContain('provider="mastodon"')
  })

  it('every metric carries a HELP line', async () => {
    const { body } = await scrape()
    const names = [...body.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]!)
    const helped = new Set([...body.matchAll(/^# HELP (\S+)/gm)].map((m) => m[1]!))

    // A metric with no help text is one whoever gets paged at 3am has to read
    // our source to interpret. Cheap to write now, expensive to look up then.
    expect(names.filter((n) => !helped.has(n))).toEqual([])
  })

  it('reports event-loop lag, which is why prom-client is here at all', async () => {
    // The characteristic failure of the worker is a transcode pinning the loop
    // while every other job silently stops — invisible in every application
    // counter, because publishes simply stop arriving.
    const { body } = await scrape()
    expect(body).toContain('smm_nodejs_eventloop_lag_seconds')
  })

  it('keeps local budget denials separate from provider 429s', async () => {
    // These look alike on a graph and mean opposite things: one is the budget
    // working, the other is our documented limit being wrong. One counter for
    // both makes the distinction the rate-limit design rests on unmeasurable.
    budgetDenials.inc({ provider: 'youtube', operation: 'publish' })
    providerRateLimits.inc({ provider: 'youtube' })

    const { body } = await scrape()
    expect(body).toMatch(/smm_budget_denials_total\{provider="youtube",operation="publish"\} 1/)
    expect(body).toMatch(/smm_provider_rate_limits_total\{provider="youtube"\} 1/)
  })

  it('a gauge can go down again, unlike a counter', async () => {
    overdueVariants.set(12)
    overdueVariants.set(0)

    const { body } = await scrape()
    expect(body).toMatch(/^smm_variants_overdue 0$/m)
  })

  it('publish duration buckets reach past a video upload', async () => {
    // A 90-second publish: slow, and entirely normal when the post carries a
    // video that had to be uploaded. The default buckets top out at 10s, which
    // would drop every one of these into +Inf — precisely the requests worth
    // measuring.
    publishDuration.observe({ provider: 'youtube' }, 90)

    const { body } = await scrape()
    expect(body).toContain('smm_publish_duration_seconds_bucket')
    // Counted in a real bucket, not only in the overflow.
    expect(body).toMatch(/smm_publish_duration_seconds_bucket\{le="120",provider="youtube"\} 1/)
  })

  it('http duration is labelled by route, never by url', async () => {
    // An unbounded label value gives every request its own time series and
    // takes the monitoring system down — an observability change causing the
    // outage it was added to catch.
    httpDuration.observe({ method: 'GET', route: '/api/v1/posts/:id', status: '2xx' }, 0.02)

    const { body } = await scrape()
    expect(body).toContain('route="/api/v1/posts/:id"')
    expect(body).not.toMatch(/route="[^"]*[0-9a-f]{8}-/)
  })

  it('resets values without losing the definitions', async () => {
    publishOutcomes.inc({ provider: 'bluesky', outcome: 'failed' })
    resetMetrics()

    const { body } = await scrape()
    // The series is gone, but the metric is still declared — a scrape after a
    // reset must not look like a deployment that lost half its instrumentation.
    expect(body).toContain('# TYPE smm_publish_outcomes_total counter')
    expect(body).not.toContain('provider="bluesky"')
  })
})
