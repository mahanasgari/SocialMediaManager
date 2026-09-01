import { describe, expect, it } from 'vitest'
import {
  describeRule,
  localDate,
  nextOccurrences,
  occurrencesBetween,
  offsetMinutes,
  zonedTimeToUtc,
  type RecurrenceRule,
} from './recurrence.js'

/**
 * Recurrence, and the DST arithmetic underneath it.
 *
 * The plan names "recurrence and DST math" as a required unit test, and it is
 * required for a specific reason: this is where scheduling software fails
 * silently. A rule stored as an instant plus an interval works perfectly until
 * a clock change, after which every post lands an hour out forever and nothing
 * reports a problem.
 *
 * The dates below are real transitions, not invented ones:
 *   Europe/Berlin  29 Mar 2026 (02:00 → 03:00) and 25 Oct 2026 (03:00 → 02:00)
 *   America/New_York 8 Mar 2026 (02:00 → 03:00)
 */

const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  freq: 'DAILY',
  interval: 1,
  hour: 9,
  minute: 0,
  timezone: 'Europe/Berlin',
  startsOn: '2026-03-01',
  ...over,
})

/** What the clock reads in a zone at a given instant. */
const wallTime = (instant: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant)

describe('offsets', () => {
  it('reads a positive offset east of UTC', () => {
    // Berlin in January is UTC+1.
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(60)
  })

  it('reads summer time as a different offset in the same zone', () => {
    expect(offsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Europe/Berlin')).toBe(120)
  })

  it('reads a negative offset west of UTC', () => {
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300)
  })

  it('handles a zone at a half-hour offset', () => {
    // India is UTC+5:30 and never changes. A codebase that assumes whole hours
    // is wrong for a fifth of the world's population.
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(330)
  })

  it('handles a zone at a three-quarter-hour offset', () => {
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Asia/Kathmandu')).toBe(345)
  })

  it('is correct at midnight, where hour 24 would put it a day out', () => {
    // Some engines render midnight as hour 24 under hour12:false. Unnormalised
    // that produces a wrong offset only for zones that happen to be at
    // midnight — an intermittent bug of the worst kind.
    expect(offsetMinutes(new Date('2026-01-15T23:00:00Z'), 'Europe/Berlin')).toBe(60)
  })
})

describe('wall-clock to instant', () => {
  it('converts a winter time correctly', () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z'
    )
  })

  it('converts a summer time correctly, an hour further from UTC', () => {
    expect(zonedTimeToUtc(2026, 7, 15, 9, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-15T07:00:00.000Z'
    )
  })

  it('converts west of UTC', () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z'
    )
  })

  it('shifts a time that does not exist forward, rather than losing it', () => {
    // 29 March 2026, Berlin clocks jump 02:00 → 03:00. 02:30 never happens.
    // A skipped post is worse than a shifted one: the author gets no signal.
    const instant = zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin')
    expect(wallTime(instant, 'Europe/Berlin')).toBe('03:30')
  })

  it('takes the EARLIER of an ambiguous time', () => {
    // 25 October 2026, Berlin clocks fall 03:00 → 02:00, so 02:30 happens
    // twice. The post goes out the first time the clock reads 02:30.
    const instant = zonedTimeToUtc(2026, 10, 25, 2, 30, 'Europe/Berlin')
    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(wallTime(instant, 'Europe/Berlin')).toBe('02:30')
  })

  it('round-trips any ordinary time', () => {
    for (const [y, m, d, h] of [
      [2026, 2, 14, 6],
      [2026, 6, 30, 23],
      [2026, 11, 3, 0],
    ] as const) {
      const instant = zonedTimeToUtc(y, m, d, h, 15, 'Europe/Berlin')
      expect(wallTime(instant, 'Europe/Berlin')).toBe(`${String(h).padStart(2, '0')}:15`)
    }
  })
})

describe('daily', () => {
  it('keeps the wall-clock hour ACROSS a spring-forward boundary', () => {
    // The property the whole design exists for. Stored as an instant plus 24
    // hours, the post after the transition lands at 08:00 and stays wrong
    // forever.
    const occurrences = occurrencesBetween(
      rule({ startsOn: '2026-03-27' }),
      new Date('2026-03-27T00:00:00Z'),
      new Date('2026-03-31T00:00:00Z')
    )

    expect(occurrences).toHaveLength(4)
    for (const instant of occurrences) {
      expect(wallTime(instant, 'Europe/Berlin')).toBe('09:00')
    }

    // And the underlying instants genuinely differ by an hour across the jump.
    expect(occurrences[0]!.toISOString()).toBe('2026-03-27T08:00:00.000Z')
    expect(occurrences[3]!.toISOString()).toBe('2026-03-30T07:00:00.000Z')
  })

  it('keeps the wall-clock hour across a fall-back boundary', () => {
    const occurrences = occurrencesBetween(
      rule({ startsOn: '2026-10-23' }),
      new Date('2026-10-23T00:00:00Z'),
      new Date('2026-10-28T00:00:00Z')
    )

    for (const instant of occurrences) {
      expect(wallTime(instant, 'Europe/Berlin')).toBe('09:00')
    }
    expect(occurrences[0]!.toISOString()).toBe('2026-10-23T07:00:00.000Z')
    expect(occurrences.at(-1)!.toISOString()).toBe('2026-10-27T08:00:00.000Z')
  })

  it('honours an interval', () => {
    const occurrences = occurrencesBetween(
      rule({ interval: 3, startsOn: '2026-06-01' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-11T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-01',
      '2026-06-04',
      '2026-06-07',
      '2026-06-10',
    ])
  })

  it('produces nothing before the start date', () => {
    const occurrences = occurrencesBetween(
      rule({ startsOn: '2026-06-10' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-09T00:00:00Z')
    )
    expect(occurrences).toEqual([])
  })

  it('stops at the end date, inclusive', () => {
    const occurrences = occurrencesBetween(
      rule({ startsOn: '2026-06-01', endsOn: '2026-06-03' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-30T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ])
  })
})

describe('weekly', () => {
  it('fires on the chosen weekdays', () => {
    // Weekdays: Monday through Friday.
    const occurrences = occurrencesBetween(
      rule({ freq: 'WEEKLY', byWeekday: [1, 2, 3, 4, 5], startsOn: '2026-06-01' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-08T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ])
  })

  it('counts fortnights by WEEK, not by day', () => {
    // "Every 2 weeks on Monday and Thursday" starting on a Thursday. Counting
    // from the start date instead puts the next Monday in a different week and
    // the pattern lands on alternating days rather than alternating weeks.
    const occurrences = occurrencesBetween(
      // 2026-06-04 is a Thursday.
      rule({ freq: 'WEEKLY', interval: 2, byWeekday: [1, 4], startsOn: '2026-06-04' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z')
    )

    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-04', // Thu, week 0
      '2026-06-15', // Mon, week 2
      '2026-06-18', // Thu, week 2
      '2026-06-29', // Mon, week 4
    ])
  })

  it('falls back to the start weekday when none is chosen', () => {
    const occurrences = occurrencesBetween(
      // A Wednesday.
      rule({ freq: 'WEEKLY', startsOn: '2026-06-03' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-25T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-03',
      '2026-06-10',
      '2026-06-17',
      '2026-06-24',
    ])
  })
})

describe('monthly', () => {
  it('fires on the chosen day', () => {
    const occurrences = occurrencesBetween(
      rule({ freq: 'MONTHLY', byMonthDay: 15, startsOn: '2026-01-15' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ])
  })

  it('SKIPS a month that has no such day, rather than clamping', () => {
    // The 31st clamped to the 30th is a post on a date nobody chose, and in
    // February it moves by three days — which reads as a bug even though every
    // individual step was reasonable.
    const occurrences = occurrencesBetween(
      rule({ freq: 'MONTHLY', byMonthDay: 31, startsOn: '2026-01-31' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ])
  })

  it('supports the last day of the month, which every month has', () => {
    const occurrences = occurrencesBetween(
      rule({ freq: 'MONTHLY', byMonthDay: -1, startsOn: '2026-01-01' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('counts the interval in months, not in elapsed days', () => {
    // Otherwise "every 2 months" drifts, because February is not July.
    const occurrences = occurrencesBetween(
      rule({ freq: 'MONTHLY', interval: 2, byMonthDay: 1, startsOn: '2026-01-01' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-08-01T00:00:00Z')
    )
    expect(occurrences.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-01-01',
      '2026-03-01',
      '2026-05-01',
      '2026-07-01',
    ])
  })
})

describe('window boundaries', () => {
  it('does not drop an occurrence whose local date sits outside the window', () => {
    // Auckland is far enough east that an instant inside the window belongs to
    // a local date outside it. Walking only the dates between the bounds loses
    // exactly those.
    const occurrences = occurrencesBetween(
      rule({ timezone: 'Pacific/Auckland', hour: 9, startsOn: '2026-06-01' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-02T00:00:00Z')
    )
    // 09:00 on 2 June in Auckland is 21:00 on 1 June UTC — inside the window,
    // on a local date the naive bound would have excluded.
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]!.toISOString()).toBe('2026-06-01T21:00:00.000Z')
  })

  it('is half-open, so a rolling window never repeats or skips', () => {
    // The expansion job asks for consecutive windows. An inclusive upper bound
    // would emit the boundary occurrence twice; an exclusive lower bound would
    // lose it.
    const first = occurrencesBetween(
      rule({ startsOn: '2026-06-01' }),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-02T07:00:00.000Z')
    )
    const second = occurrencesBetween(
      rule({ startsOn: '2026-06-01' }),
      new Date('2026-06-02T07:00:00.000Z'),
      new Date('2026-06-04T00:00:00Z')
    )

    const all = [...first, ...second].map((d) => d.toISOString())
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain('2026-06-02T07:00:00.000Z')
  })

  it('returns nothing for an inverted window instead of looping', () => {
    expect(
      occurrencesBetween(rule(), new Date('2026-06-10T00:00:00Z'), new Date('2026-06-01T00:00:00Z'))
    ).toEqual([])
  })

  it('respects the limit, so a bad rule cannot run away', () => {
    const occurrences = occurrencesBetween(
      rule({ startsOn: '2026-01-01' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
      10
    )
    expect(occurrences).toHaveLength(10)
  })
})

describe('previewing', () => {
  it('returns the next few occurrences from a moment', () => {
    const next = nextOccurrences(
      rule({ freq: 'WEEKLY', byWeekday: [1], startsOn: '2026-06-01' }),
      new Date('2026-06-10T00:00:00Z'),
      3
    )
    expect(next.map((d) => localDate(d, 'Europe/Berlin'))).toEqual([
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ])
  })

  it('returns nothing for a rule that has already ended', () => {
    const next = nextOccurrences(
      rule({ startsOn: '2026-01-01', endsOn: '2026-01-31' }),
      new Date('2026-06-01T00:00:00Z')
    )
    expect(next).toEqual([])
  })
})

describe('describing a rule', () => {
  it('always names the zone', () => {
    // "Every weekday at 09:00" is ambiguous the moment two people in different
    // offices read it.
    expect(describeRule(rule({ freq: 'WEEKLY', byWeekday: [1, 3] }))).toBe(
      'every week on Monday, Wednesday at 09:00 Europe/Berlin'
    )
  })

  it('pluralises an interval', () => {
    expect(describeRule(rule({ interval: 3 }))).toBe('every 3 days at 09:00 Europe/Berlin')
  })

  it('names the last day of the month in words', () => {
    expect(describeRule(rule({ freq: 'MONTHLY', byMonthDay: -1 }))).toBe(
      'every month on the last day at 09:00 Europe/Berlin'
    )
  })
})
