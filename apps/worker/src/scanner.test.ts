import { describe, expect, it } from 'vitest'
import { ClockWentBackwards, Scanner } from './scanner.js'

/**
 * The clock guard and lateness maths are the parts worth testing without a
 * database: one prevents a duplicate-publish path the idempotency design cannot
 * see, and the other decides whether a post is "late" or "missed".
 */

describe('clock-skew guard', () => {
  it('allows time moving forward', async () => {
    const scanner = new Scanner()
    // Reaching into the private guard directly: the alternative is a database,
    // and the behaviour under test is purely about the clock.
    const guard = (scanner as unknown as { guardClock(now: Date): void }).guardClock.bind(scanner)

    expect(() => guard(new Date('2026-08-29T12:00:00Z'))).not.toThrow()
    expect(() => guard(new Date('2026-08-29T12:00:30Z'))).not.toThrow()
  })

  it('tolerates small jitter', () => {
    const scanner = new Scanner()
    const guard = (scanner as unknown as { guardClock(now: Date): void }).guardClock.bind(scanner)

    guard(new Date('2026-08-29T12:00:00Z'))
    // Sub-second NTP adjustments are constant and harmless.
    expect(() => guard(new Date('2026-08-29T11:59:59Z'))).not.toThrow()
  })

  it('refuses when the clock jumps backwards', () => {
    // An NTP correction of any size would otherwise re-claim rows that already
    // published — a duplicate-publish path entirely outside the idempotency
    // design, which reasons about retries rather than about time travel.
    const scanner = new Scanner()
    const guard = (scanner as unknown as { guardClock(now: Date): void }).guardClock.bind(scanner)

    guard(new Date('2026-08-29T12:00:00Z'))
    expect(() => guard(new Date('2026-08-29T11:58:00Z'))).toThrow(ClockWentBackwards)
  })

  it('explains why it refused, in terms of the consequence', () => {
    const scanner = new Scanner()
    const guard = (scanner as unknown as { guardClock(now: Date): void }).guardClock.bind(scanner)
    guard(new Date('2026-08-29T12:00:00Z'))

    try {
      guard(new Date('2026-08-29T11:58:00Z'))
    } catch (err) {
      expect((err as Error).message).toMatch(/already-published/)
      expect((err as Error).message).toMatch(/\d+ms/)
    }
  })
})

describe('lateness', () => {
  it('measures against the intended time, not the claim', () => {
    // A post that sat 30 seconds waiting for the sweep is late by 30 seconds.
    expect(
      Scanner.lateness(new Date('2026-08-29T12:00:00Z'), new Date('2026-08-29T12:00:30Z'))
    ).toBe(30)
  })

  it('is zero when published early or exactly on time', () => {
    expect(
      Scanner.lateness(new Date('2026-08-29T12:00:00Z'), new Date('2026-08-29T12:00:00Z'))
    ).toBe(0)
    // Never negative: "published -5 seconds late" is not a thing anyone wants
    // rendered in a UI.
    expect(
      Scanner.lateness(new Date('2026-08-29T12:00:00Z'), new Date('2026-08-29T11:59:50Z'))
    ).toBe(0)
  })

  it('rounds to whole seconds', () => {
    expect(
      Scanner.lateness(new Date('2026-08-29T12:00:00.000Z'), new Date('2026-08-29T12:00:01.600Z'))
    ).toBe(2)
  })
})

describe('reportable lateness', () => {
  // Recording lateness and REPORTING it are different questions, and conflating
  // them makes the answer useless.
  it('records any lateness, however small', () => {
    const at = new Date('2026-08-30T09:00:00Z')
    expect(Scanner.lateness(at, new Date('2026-08-30T09:00:01Z'))).toBe(1)
  })

  it('does NOT flag the delay a 30s tick inevitably produces', () => {
    // A post due at 09:00:05 is claimed on the 09:00:30 tick and is late by 25
    // seconds every single time. Flagging that would set publishedLate on
    // essentially every post, and a report whose number is always 100% tells an
    // operator nothing.
    expect(Scanner.isNotablyLate(1)).toBe(false)
    expect(Scanner.isNotablyLate(25)).toBe(false)
    expect(Scanner.isNotablyLate(30)).toBe(false)
  })

  it('tolerates one tick spent behind a batch, which is normal operation', () => {
    expect(Scanner.isNotablyLate(59)).toBe(false)
    expect(Scanner.isNotablyLate(60)).toBe(false)
  })

  it('flags delay the tick rate cannot explain', () => {
    expect(Scanner.isNotablyLate(61)).toBe(true)
    expect(Scanner.isNotablyLate(600)).toBe(true)
  })

  it('never reports negative lateness for a post published early', () => {
    // Clock adjustments happen. A negative figure would corrupt any average
    // computed over the column.
    const at = new Date('2026-08-30T09:00:00Z')
    expect(Scanner.lateness(at, new Date('2026-08-30T08:59:00Z'))).toBe(0)
  })
})
