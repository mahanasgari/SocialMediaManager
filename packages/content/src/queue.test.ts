import { describe, expect, it } from 'vitest'
import { SUGGESTED_SLOTS, describeSlot, nextFreeSlots } from './queue.js'

/**
 * The posting queue.
 *
 * The arithmetic is small; the ways it goes wrong are not. A queue that hands
 * out a past instant publishes immediately, one that hands out a taken instant
 * publishes two posts together, and one that adds seven days to an instant
 * drifts an hour at every daylight-saving change and never recovers.
 */

/**
 * Renders an instant in a zone as "Wed 02 Sep 17:30".
 *
 * Assembled from parts rather than taken from a locale pattern: ICU renders
 * September as "Sept" in en-GB and "Sep" in en-US, and a test that asserts on
 * a whole formatted string is really asserting on the ICU version installed.
 */
function at(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`
}

describe('handing out the next free slots', () => {
  const slots = [
    { dayOfWeek: 1, hour: 9, minute: 0 },
    { dayOfWeek: 3, hour: 17, minute: 30 },
  ]

  it('returns them in chronological order', () => {
    // Wednesday 2026-09-02, 08:00 UTC.
    const from = new Date('2026-09-02T08:00:00Z')
    const found = nextFreeSlots({ slots, timezone: 'UTC', taken: [], from, count: 4 })

    expect(found).toHaveLength(4)
    for (let i = 1; i < found.length; i++) {
      expect(found[i]!.getTime()).toBeGreaterThan(found[i - 1]!.getTime())
    }
    expect(found.map((d) => at(d, 'UTC'))).toEqual([
      'Wed 02 Sep 17:30',
      'Mon 07 Sep 09:00',
      'Wed 09 Sep 17:30',
      'Mon 14 Sep 09:00',
    ])
  })

  it('never hands out a slot in the past', () => {
    // 10:00 on a Monday: that day's 09:00 has gone. Handing it out would make
    // the scanner publish immediately, which is not what "queue" means.
    const from = new Date('2026-09-07T10:00:00Z')
    const [first] = nextFreeSlots({ slots, timezone: 'UTC', taken: [], from, count: 1 })
    expect(at(first!, 'UTC')).toBe('Wed 09 Sep 17:30')
  })

  it('skips an instant that is already taken', () => {
    // Two posts on one instant publish together, defeating the spacing the
    // queue exists to provide.
    const from = new Date('2026-09-02T08:00:00Z')
    const taken = [new Date('2026-09-02T17:30:00Z')]
    const [first] = nextFreeSlots({ slots, timezone: 'UTC', taken, from, count: 1 })
    expect(at(first!, 'UTC')).toBe('Mon 07 Sep 09:00')
  })

  it('does not hand the same instant to two posts in one call', () => {
    const from = new Date('2026-09-02T08:00:00Z')
    const found = nextFreeSlots({ slots, timezone: 'UTC', taken: [], from, count: 6 })
    expect(new Set(found.map((d) => d.getTime())).size).toBe(found.length)
  })

  it('returns nothing when the workspace has no slots', () => {
    // Not an error. A workspace that has not set up a queue simply has none,
    // and the caller has to say so rather than inventing a time.
    expect(nextFreeSlots({ slots: [], timezone: 'UTC', taken: [], from: new Date(), count: 3 }))
      .toEqual([])
  })

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // THE reason this reuses the recurrence conversion instead of adding
    // 7 * 86400000. Europe/Berlin leaves DST on 25 October 2026: a Monday
    // 09:00 slot before and after must both read 09:00 locally, even though
    // the UTC instants differ by an hour.
    const berlin = [{ dayOfWeek: 1, hour: 9, minute: 0 }]
    const from = new Date('2026-10-18T00:00:00Z')
    const found = nextFreeSlots({
      slots: berlin,
      timezone: 'Europe/Berlin',
      taken: [],
      from,
      count: 3,
    })

    for (const instant of found) {
      expect(at(instant, 'Europe/Berlin')).toMatch(/09:00$/)
    }
    // And the underlying instants really did shift, so this is not passing by
    // the transition being outside the window.
    expect(found[0]!.toISOString()).toBe('2026-10-19T07:00:00.000Z')
    expect(found[1]!.toISOString()).toBe('2026-10-26T08:00:00.000Z')
  })

  it('uses the workspace calendar rather than the server one', () => {
    // A server deciding what "Monday" means for a workspace in Auckland is
    // wrong for most of the day. 2026-09-06T20:00Z is Sunday evening in UTC and
    // already Monday morning in Auckland, so Monday's 09:00 slot is that day's.
    const auckland = [{ dayOfWeek: 1, hour: 9, minute: 0 }]
    const from = new Date('2026-09-06T20:00:00Z')
    const [first] = nextFreeSlots({
      slots: auckland,
      timezone: 'Pacific/Auckland',
      taken: [],
      from,
      count: 1,
    })
    expect(at(first!, 'Pacific/Auckland')).toBe('Mon 07 Sep 09:00')
  })

  it('orders several slots within one day by time', () => {
    const many = [
      { dayOfWeek: 2, hour: 17, minute: 30 },
      { dayOfWeek: 2, hour: 9, minute: 0 },
      { dayOfWeek: 2, hour: 12, minute: 15 },
    ]
    const from = new Date('2026-09-01T00:00:00Z')
    const found = nextFreeSlots({ slots: many, timezone: 'UTC', taken: [], from, count: 3 })
    expect(found.map((d) => at(d, 'UTC'))).toEqual([
      'Tue 01 Sep 09:00',
      'Tue 01 Sep 12:15',
      'Tue 01 Sep 17:30',
    ])
  })

  it('gives up at the horizon rather than looping forever', () => {
    // One slot a week cannot fill a thousand requests. Returning fewer is the
    // honest answer; the caller reports that the queue is full.
    const found = nextFreeSlots({
      slots: [{ dayOfWeek: 1, hour: 9, minute: 0 }],
      timezone: 'UTC',
      taken: [],
      from: new Date('2026-09-01T00:00:00Z'),
      count: 1000,
    })
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThan(1000)
  })
})

describe('describing a slot', () => {
  it('reads as a day and a time', () => {
    expect(describeSlot({ dayOfWeek: 2, hour: 9, minute: 0 })).toBe('Tue 09:00')
    expect(describeSlot({ dayOfWeek: 0, hour: 17, minute: 5 })).toBe('Sun 17:05')
  })
})

describe('the suggested starting queue', () => {
  it('has no duplicate moments', () => {
    // The database enforces this too; a suggestion that violates it would fail
    // halfway through and leave a partial queue.
    const keys = SUGGESTED_SLOTS.map((s) => `${s.dayOfWeek}-${s.hour}-${s.minute}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('stays inside real days and times', () => {
    for (const slot of SUGGESTED_SLOTS) {
      expect(slot.dayOfWeek).toBeGreaterThanOrEqual(0)
      expect(slot.dayOfWeek).toBeLessThanOrEqual(6)
      expect(slot.hour).toBeLessThanOrEqual(23)
      expect(slot.minute).toBeLessThanOrEqual(59)
    }
  })
})
