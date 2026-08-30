import { describe, expect, it } from 'vitest'
import { isPurgeDue, purgeDateFor } from './retention.js'

const deletedAt = new Date('2026-08-01T09:00:00Z')

describe('purge date', () => {
  // Pure so the UI can show the SAME date the job acts on. Telling someone
  // their data goes "in about a month" while the job does its own arithmetic is
  // how a deletion promise becomes a support ticket.
  it('is the deletion date plus the grace period', () => {
    expect(purgeDateFor(deletedAt, 30).toISOString()).toBe('2026-08-31T09:00:00.000Z')
  })

  it('preserves the time of day, so the window is a full 30 days', () => {
    // Rounding to midnight would silently shorten or lengthen the grace period
    // depending on when someone happened to click delete.
    expect(purgeDateFor(deletedAt, 7).toISOString()).toBe('2026-08-08T09:00:00.000Z')
  })

  it('handles a one-day grace period', () => {
    expect(purgeDateFor(deletedAt, 1).toISOString()).toBe('2026-08-02T09:00:00.000Z')
  })
})

describe('purge eligibility', () => {
  it('is not due during the grace period', () => {
    expect(isPurgeDue(deletedAt, 30, new Date('2026-08-30T23:59:59Z'))).toBe(false)
  })

  it('is not due one second early', () => {
    // The boundary matters: this is irreversible destruction, and being a
    // second eager is indistinguishable from being wrong.
    expect(isPurgeDue(deletedAt, 30, new Date('2026-08-31T08:59:59Z'))).toBe(false)
  })

  it('is due exactly on the boundary', () => {
    expect(isPurgeDue(deletedAt, 30, new Date('2026-08-31T09:00:00Z'))).toBe(true)
  })

  it('is due afterwards', () => {
    expect(isPurgeDue(deletedAt, 30, new Date('2026-09-15T00:00:00Z'))).toBe(true)
  })

  it('respects a longer grace period', () => {
    expect(isPurgeDue(deletedAt, 90, new Date('2026-09-15T00:00:00Z'))).toBe(false)
    expect(isPurgeDue(deletedAt, 90, new Date('2026-11-01T00:00:00Z'))).toBe(true)
  })
})
