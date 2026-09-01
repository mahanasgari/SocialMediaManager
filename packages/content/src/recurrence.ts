/**
 * Recurring schedules, and the timezone arithmetic they need.
 *
 * "Every weekday at 09:00" is the single most requested thing a scheduler does,
 * and it is also where scheduling software most often quietly breaks. The
 * failure is always the same: a rule stored as an absolute instant plus an
 * interval. That works perfectly until a daylight-saving boundary, after which
 * every post lands an hour early or an hour late, forever, and nobody notices
 * until somebody points at a 08:00 post and asks why.
 *
 * So the rule stores a WALL-CLOCK TIME and an IANA ZONE — 09:00 in
 * Europe/Berlin — and each occurrence is converted to an absolute instant at
 * expansion time. 09:00 stays 09:00 through the transition, which is what the
 * person meant, and the stored `scheduledAt` is still a plain UTC instant that
 * nothing else has to reason about.
 *
 * NOT RFC 5545. A full RRULE implementation is a large surface — BYSETPOS,
 * BYYEARDAY, WKST, and the interactions between them — and social scheduling
 * uses almost none of it. What is here covers daily, weekly-on-chosen-days and
 * monthly-on-a-date, which is what the feature is actually for. A rule this
 * code cannot express is better refused than half-honoured.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type RecurrenceRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  /** Every N days, weeks or months. 1 means every one. */
  interval: number
  /** For WEEKLY. 0 is Sunday. Empty means "the weekday the rule starts on". */
  byWeekday?: Weekday[]
  /** For MONTHLY. 1–31, or -1 for the last day of the month. */
  byMonthDay?: number
  /** Wall-clock time in `timezone`, not UTC. */
  hour: number
  minute: number
  /** IANA zone, e.g. 'Europe/Berlin'. */
  timezone: string
  /** First eligible date, as a local calendar date: 'YYYY-MM-DD'. */
  startsOn: string
  /** Last eligible date, inclusive. Absent means it runs until stopped. */
  endsOn?: string | undefined
}

/**
 * Minutes east of UTC for a given instant in a given zone.
 *
 * Derived by formatting the instant in the zone and comparing the wall-clock
 * fields back against UTC — the only approach that works for every zone without
 * shipping a copy of the tz database, because the browser and Node already have
 * one and it is kept current by the platform.
 */
export function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)

  // Some engines render midnight as hour 24 under hour12:false. Left
  // unnormalised it puts the offset a day out, and only for zones that happen
  // to be at midnight — an intermittent bug of the worst kind.
  const hour = get('hour') % 24

  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return Math.round((asUtc - instant.getTime()) / 60_000)
}

/**
 * Turns a wall-clock time in a zone into an absolute instant.
 *
 * Two passes, and the second one is the whole point. The first guess uses the
 * offset in force at the *wrong* instant — the wall time read as if it were
 * UTC — which is off by the offset itself. Correcting once lands close enough
 * that the offset there is normally right; measuring again catches the case
 * where the correction crossed a DST boundary and the offset changed underneath
 * it.
 *
 * The two boundary cases have no single correct answer, so this picks one and
 * says which:
 *
 *   SPRING FORWARD, the hour that does not exist. 02:30 on a night the clocks
 *   go 02:00 → 03:00 never happens. The instant returned is the one the wall
 *   time maps to after the jump — the post goes out at 03:30 local rather than
 *   silently vanishing. A skipped post is worse than a shifted one, because the
 *   author gets no signal at all.
 *
 *   FALL BACK, the hour that happens twice. 02:30 occurs at both offsets. The
 *   EARLIER instant is returned, so the post goes out the first time the clock
 *   reads 02:30 rather than an hour later.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute)

  // Both offsets in force around this date, sampled a day either side. A
  // transition moves the offset by at most a couple of hours, so a day's margin
  // brackets it with room to spare, and outside a transition the two samples
  // are identical and this collapses to one candidate.
  //
  // Sampling rather than iterating is what makes the two hard cases decidable:
  // an ambiguous time has TWO valid answers and a nonexistent one has NONE, and
  // no amount of refining a single guess can tell those apart.
  const before = offsetMinutes(new Date(asIfUtc - 86_400_000), timezone)
  const after = offsetMinutes(new Date(asIfUtc + 86_400_000), timezone)

  const candidates = [...new Set([before, after])].map((offset) => asIfUtc - offset * 60_000)

  // A candidate is real only if reading it back in the zone gives the wall time
  // that was asked for.
  const valid = candidates.filter((instant) => rendersAs(instant, timezone, hour, minute))

  // AMBIGUOUS — the hour that happens twice. Both are real; the earlier one is
  // the first time the clock reads what the author wrote.
  if (valid.length > 0) return new Date(Math.min(...valid))

  // NONEXISTENT — the hour that never happens. Neither candidate is real, so
  // the later one is taken, which lands just past the jump: a 02:30 rule fires
  // at 03:30. A skipped post would be worse, because the author gets no signal
  // that anything was dropped.
  return new Date(Math.max(...candidates))
}

/** Whether an instant reads as this wall-clock time in this zone. */
function rendersAs(instant: number, timezone: string, hour: number, minute: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant))

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? -1)
  return get('hour') % 24 === hour && get('minute') === minute
}

/** The local calendar date of an instant, in a zone: 'YYYY-MM-DD'. */
export function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

type CalendarDate = { year: number; month: number; day: number }

function parseDate(value: string): CalendarDate {
  const [y, m, d] = value.split('-').map(Number)
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 }
}

/** Days are counted on the proleptic calendar, never by adding milliseconds. */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function weekdayOf(date: CalendarDate): Weekday {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as Weekday
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function compare(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day
}

/**
 * How many whole months from one date to another, ignoring the day.
 *
 * Used for the MONTHLY interval check. Comparing on months rather than on
 * elapsed days is what makes "every 2 months" mean the same thing in February
 * as in July.
 */
function monthsBetween(from: CalendarDate, to: CalendarDate): number {
  return (to.year - from.year) * 12 + (to.month - from.month)
}

/**
 * Whether a local date is one this rule fires on.
 *
 * Date arithmetic only — the time of day and the zone are applied afterwards,
 * so a DST transition can never change WHICH day a post belongs to. Deciding
 * the day from an instant instead is how "every Monday" produces a Sunday post
 * for anyone east of UTC.
 */
function matchesDate(rule: RecurrenceRule, start: CalendarDate, date: CalendarDate): boolean {
  const interval = Math.max(1, Math.floor(rule.interval))

  switch (rule.freq) {
    case 'DAILY': {
      const elapsed = Math.round(
        (Date.UTC(date.year, date.month - 1, date.day) -
          Date.UTC(start.year, start.month - 1, start.day)) /
          86_400_000
      )
      return elapsed >= 0 && elapsed % interval === 0
    }

    case 'WEEKLY': {
      const days = rule.byWeekday?.length ? rule.byWeekday : [weekdayOf(start)]
      if (!days.includes(weekdayOf(date))) return false

      // Weeks are counted from the START OF THE WEEK containing `startsOn`, not
      // from the start date itself. Otherwise "every 2 weeks on Mon and Thu"
      // beginning on a Thursday puts the following Monday in week 0 and the one
      // after in week 1 — and the pattern lands on alternating days rather than
      // alternating weeks.
      const startWeek = addDays(start, -weekdayOf(start))
      const thisWeek = addDays(date, -weekdayOf(date))
      const weeks = Math.round(
        (Date.UTC(thisWeek.year, thisWeek.month - 1, thisWeek.day) -
          Date.UTC(startWeek.year, startWeek.month - 1, startWeek.day)) /
          (7 * 86_400_000)
      )
      return weeks >= 0 && weeks % interval === 0
    }

    case 'MONTHLY': {
      const months = monthsBetween(start, date)
      if (months < 0 || months % interval !== 0) return false

      const wanted = rule.byMonthDay ?? start.day
      if (wanted === -1) return date.day === daysInMonth(date.year, date.month)

      // A day the month does not have is SKIPPED, not clamped. "The 31st"
      // clamped to the 30th is a post on a date the author did not choose, and
      // in February it would move by three days — which reads as a bug even
      // though every step was reasonable.
      return date.day === wanted
    }

    default:
      return false
  }
}

/**
 * Every occurrence in `[from, to)`, as absolute instants, in order.
 *
 * Bounded by the caller's window rather than by a count, because the expansion
 * job works on a rolling horizon: it asks for the next sixty days on every
 * pass, and what it gets back must not depend on how many times it has asked
 * before.
 */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  limit = 500
): Date[] {
  const out: Date[] = []
  if (to <= from) return out

  const start = parseDate(rule.startsOn)
  const end = rule.endsOn ? parseDate(rule.endsOn) : null

  // Walk local calendar dates across the window, widened by a day at each edge:
  // a zone far enough from UTC can put an instant inside the window on a local
  // date outside it, and the naive bound drops exactly those posts.
  let cursor = parseDate(localDate(new Date(from.getTime() - 86_400_000), rule.timezone))
  const last = parseDate(localDate(new Date(to.getTime() + 86_400_000), rule.timezone))

  if (compare(cursor, start) < 0) cursor = start

  while (compare(cursor, last) <= 0 && out.length < limit) {
    if (end && compare(cursor, end) > 0) break

    if (matchesDate(rule, start, cursor)) {
      const instant = zonedTimeToUtc(
        cursor.year,
        cursor.month,
        cursor.day,
        rule.hour,
        rule.minute,
        rule.timezone
      )
      if (instant >= from && instant < to) out.push(instant)
    }

    cursor = addDays(cursor, 1)
  }

  return out
}

/** The next `count` occurrences at or after `from`. For previewing a rule. */
export function nextOccurrences(rule: RecurrenceRule, from: Date, count = 5): Date[] {
  // A year is enough to find five of anything this grammar can express, and
  // bounds the walk for a rule that matches nothing at all.
  const horizon = new Date(from.getTime() + 366 * 86_400_000)
  return occurrencesBetween(rule, from, horizon, count)
}

/** Human-readable summary of a rule, for confirming what was understood. */
export function describeRule(rule: RecurrenceRule): string {
  const time = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`
  const every = rule.interval > 1 ? `every ${rule.interval} ` : 'every '

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  let when: string
  switch (rule.freq) {
    case 'DAILY':
      when = `${every}${rule.interval > 1 ? 'days' : 'day'}`
      break
    case 'WEEKLY': {
      const days = rule.byWeekday?.length ? rule.byWeekday : []
      const listed = days.length ? ` on ${days.map((d) => names[d]).join(', ')}` : ''
      when = `${every}${rule.interval > 1 ? 'weeks' : 'week'}${listed}`
      break
    }
    case 'MONTHLY': {
      const day =
        rule.byMonthDay === -1
          ? 'the last day'
          : `day ${rule.byMonthDay ?? Number(rule.startsOn.slice(8))}`
      when = `${every}${rule.interval > 1 ? 'months' : 'month'} on ${day}`
      break
    }
    default:
      when = 'never'
  }

  // The zone is named, always. "Every weekday at 09:00" is ambiguous the moment
  // two people in different offices read it.
  return `${when} at ${time} ${rule.timezone}`
}
