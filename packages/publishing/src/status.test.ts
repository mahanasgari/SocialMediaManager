import { describe, expect, it } from 'vitest'
import {
  derivePostStatus,
  describeStatus,
  shouldDerive,
  VARIANT_STATUSES,
  type VariantStatus,
} from './status.js'

describe('single-variant posts', () => {
  it.each([
    [['DRAFT'], 'DRAFT'],
    [['SCHEDULED'], 'SCHEDULED'],
    [['QUEUED'], 'SCHEDULED'],
    [['PREPARING_MEDIA'], 'PUBLISHING'],
    [['PUBLISHING'], 'PUBLISHING'],
    [['PUBLISHED'], 'PUBLISHED'],
    [['FAILED'], 'FAILED'],
    [['CANCELLED'], 'CANCELLED'],
    [['MISSED'], 'MISSED'],
    [['NEEDS_REVIEW'], 'NEEDS_REVIEW'],
  ] as [VariantStatus[], string][])('%s -> %s', (variants, expected) => {
    expect(derivePostStatus(variants)).toBe(expected)
  })
})

describe('partial publishing — the normal outcome, not an exception', () => {
  it('one published, one failed is PARTIALLY_PUBLISHED', () => {
    // Saying PUBLISHED here would be a lie; saying FAILED would be a different
    // lie. The state exists because neither is true.
    expect(derivePostStatus(['PUBLISHED', 'FAILED'])).toBe('PARTIALLY_PUBLISHED')
  })

  it('one published, one missed is PARTIALLY_PUBLISHED', () => {
    expect(derivePostStatus(['PUBLISHED', 'MISSED'])).toBe('PARTIALLY_PUBLISHED')
  })

  it('one published, one cancelled is PARTIALLY_PUBLISHED', () => {
    expect(derivePostStatus(['PUBLISHED', 'CANCELLED'])).toBe('PARTIALLY_PUBLISHED')
  })

  it('three published and one failed is still PARTIALLY_PUBLISHED', () => {
    expect(derivePostStatus(['PUBLISHED', 'PUBLISHED', 'PUBLISHED', 'FAILED'])).toBe(
      'PARTIALLY_PUBLISHED'
    )
  })

  it('all published is PUBLISHED', () => {
    expect(derivePostStatus(['PUBLISHED', 'PUBLISHED'])).toBe('PUBLISHED')
  })
})

describe('NEEDS_REVIEW outranks everything', () => {
  // A variant we cannot confirm either way is the one thing somebody has to act
  // on. Summarising it as PARTIALLY_PUBLISHED would bury it.
  it.each([
    ['alongside published', ['PUBLISHED', 'NEEDS_REVIEW']],
    ['alongside failed', ['FAILED', 'NEEDS_REVIEW']],
    ['alongside publishing', ['PUBLISHING', 'NEEDS_REVIEW']],
    ['alongside cancelled', ['CANCELLED', 'NEEDS_REVIEW']],
    ['alongside everything', ['PUBLISHED', 'FAILED', 'MISSED', 'NEEDS_REVIEW']],
  ] as [string, VariantStatus[]][])('%s', (_label, variants) => {
    expect(derivePostStatus(variants)).toBe('NEEDS_REVIEW')
  })
})

describe('in-flight work', () => {
  it('any publishing variant makes the post PUBLISHING', () => {
    expect(derivePostStatus(['PUBLISHED', 'PUBLISHING'])).toBe('PUBLISHING')
  })

  it('media preparation counts as publishing', () => {
    // A variant sitting in PREPARING_MEDIA for six minutes during a video
    // transcode is progress, not a stall — but from the post's point of view it
    // is the same "in flight".
    expect(derivePostStatus(['PREPARING_MEDIA'])).toBe('PUBLISHING')
    expect(derivePostStatus(['SCHEDULED', 'PREPARING_MEDIA'])).toBe('PUBLISHING')
  })

  it('scheduled beats draft when mixed', () => {
    expect(derivePostStatus(['DRAFT', 'SCHEDULED'])).toBe('SCHEDULED')
  })
})

describe('cancellation does not mask the outcome of other channels', () => {
  it('all cancelled is CANCELLED', () => {
    expect(derivePostStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED')
  })

  it('cancelled plus failed is FAILED, not CANCELLED', () => {
    // Disconnecting an account cancels its variants. If that turned a post whose
    // other channel genuinely failed into "cancelled", the failure would vanish.
    expect(derivePostStatus(['CANCELLED', 'FAILED'])).toBe('FAILED')
  })

  it('cancelled plus missed is MISSED', () => {
    expect(derivePostStatus(['CANCELLED', 'MISSED'])).toBe('MISSED')
  })
})

describe('exhaustive cross-product', () => {
  // The reducer must total: every pair of variant states has to produce a
  // defined post status, or some combination renders as undefined in the UI.
  it('every ordered pair yields a valid status', () => {
    for (const a of VARIANT_STATUSES) {
      for (const b of VARIANT_STATUSES) {
        const result = derivePostStatus([a, b])
        expect(result, `${a} + ${b}`).toBeTruthy()
        expect(typeof result).toBe('string')
      }
    }
  })

  it('is order-independent', () => {
    // Variants come back from the database in whatever order the query gives.
    for (const a of VARIANT_STATUSES) {
      for (const b of VARIANT_STATUSES) {
        expect(derivePostStatus([a, b]), `${a},${b}`).toBe(derivePostStatus([b, a]))
      }
    }
  })

  it('a single variant repeated matches the single case', () => {
    for (const s of VARIANT_STATUSES) {
      expect(derivePostStatus([s, s]), s).toBe(derivePostStatus([s]))
    }
  })

  it('an empty post is a draft', () => {
    expect(derivePostStatus([])).toBe('DRAFT')
  })
})

describe('editorial statuses are not derived', () => {
  it('refuses to overwrite PENDING_APPROVAL', () => {
    // Approvals ship in Phase 5. Until then these states exist unused — but the
    // reducer must never silently rewrite one back to DRAFT.
    expect(shouldDerive('PENDING_APPROVAL')).toBe(false)
    expect(shouldDerive('APPROVED')).toBe(false)
  })

  it('derives over every pipeline-owned status', () => {
    expect(shouldDerive('DRAFT')).toBe(true)
    expect(shouldDerive('SCHEDULED')).toBe(true)
    expect(shouldDerive('PARTIALLY_PUBLISHED')).toBe(true)
  })
})

describe('human descriptions', () => {
  it('says how many channels succeeded on a partial publish', () => {
    expect(describeStatus('PARTIALLY_PUBLISHED', { published: 2, total: 3 })).toBe(
      'Published to 2 of 3 channels'
    )
  })

  it('explains NEEDS_REVIEW in terms of what happened, not the enum name', () => {
    const text = describeStatus('NEEDS_REVIEW', { published: 0, total: 1 })
    expect(text).toMatch(/could not confirm/i)
    expect(text).not.toMatch(/NEEDS_REVIEW/)
  })

  it('does not say "all channels" for a single-channel post', () => {
    expect(describeStatus('PUBLISHED', { published: 1, total: 1 })).toBe('Published')
    expect(describeStatus('PUBLISHED', { published: 3, total: 3 })).toBe(
      'Published to all 3 channels'
    )
  })
})
