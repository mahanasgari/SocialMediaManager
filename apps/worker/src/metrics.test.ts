import { describe, expect, it } from 'vitest'
import { engagementRate, isDue } from './metrics.js'

const PUBLISHED = new Date('2026-08-29T12:00:00Z')
const hoursAfter = (h: number) => new Date(PUBLISHED.getTime() + h * 3_600_000)

describe('decaying poll schedule', () => {
  // Engagement is front-loaded, so sampling densely early and sparsely later
  // captures the curve at a fraction of the request cost — and those requests
  // compete for the same provider quota as publishing.
  it.each([1, 6, 24, 72, 168, 720])('is due at %ih after publish', (h) => {
    expect(isDue(PUBLISHED, null, hoursAfter(h))).toBe(true)
  })

  it.each([0.2, 3, 12, 48, 100, 300, 1000])('is not due at %ih', (h) => {
    expect(isDue(PUBLISHED, null, hoursAfter(h))).toBe(false)
  })

  it('tolerates a tick running slightly late', () => {
    // A worker that ticks every 30s will rarely hit exactly 1h.
    expect(isDue(PUBLISHED, null, hoursAfter(1.3))).toBe(true)
    expect(isDue(PUBLISHED, null, hoursAfter(0.7))).toBe(true)
  })

  it('does not sample the same point twice', () => {
    // Otherwise a tick every 30 seconds would collect dozens of rows around each
    // scheduled point and burn the quota it exists to conserve.
    const justCollected = hoursAfter(1)
    expect(isDue(PUBLISHED, justCollected, hoursAfter(1.1))).toBe(false)
  })

  it('samples the next point even though an earlier one was collected', () => {
    expect(isDue(PUBLISHED, hoursAfter(1), hoursAfter(6))).toBe(true)
  })
})

describe('engagement rate', () => {
  it('is interactions over reach, as a percentage', () => {
    expect(
      engagementRate({ reach: 1000, likes: 40, comments: 8, shares: 2, saves: 0 })
    ).toBe(5)
  })

  it('falls back to impressions when reach is absent', () => {
    expect(engagementRate({ impressions: 200, likes: 10, reach: null })).toBe(5)
  })

  it('returns NULL, not zero, when the denominator is missing', () => {
    // "0% engagement" and "we do not know the engagement" are different claims,
    // and only one of them is true. A chart showing a flat zero line for a
    // platform that reports no reach is actively misleading.
    expect(engagementRate({ likes: 40, reach: null, impressions: null })).toBeNull()
    expect(engagementRate({ reach: 0, likes: 40 })).toBeNull()
  })

  it('treats missing interaction counts as zero, not as unknown', () => {
    // A platform reporting reach but no saves genuinely had no saves counted;
    // that is different from not knowing the reach at all.
    expect(engagementRate({ reach: 100, likes: 5, saves: null })).toBe(5)
  })

  it('rounds to two decimal places', () => {
    expect(engagementRate({ reach: 3, likes: 1 })).toBe(33.33)
  })
})
