import { zonedTimeToUtc } from './recurrence.js'

/**
 * The posting queue: turning "when we post" into "when this post goes out".
 *
 * A workspace declares slots — Tuesdays at 09:00, weekdays at 17:30 — and a new
 * post takes the next one nobody has taken. That is the whole feature, and the
 * only hard parts are the two this module exists for.
 *
 * WALL CLOCK, NOT INSTANTS. A slot is "09:00 on Tuesday in this workspace's
 * zone", converted at the moment it is handed out. Storing an instant and
 * adding seven days works until a daylight-saving change and then puts every
 * post an hour out, permanently, with nothing reporting a problem. This reuses
 * the recurrence conversion rather than repeating it — one piece of DST
 * arithmetic in this codebase, already tested against real transitions.
 *
 * TAKEN SLOTS ARE SKIPPED. Two posts on the same instant publish together,
 * which defeats the point of spacing them. The caller passes what is already
 * scheduled and the walk steps over those.
 */

export type Slot = {
  /** 0 is Sunday, matching Date.getDay(). */
  dayOfWeek: number
  hour: number
  minute: number
}

/** How far ahead to look before giving up. */
const HORIZON_DAYS = 120

/**
 * The next `count` free slot instants, in order, at or after `from`.
 *
 * Returns fewer than asked for only when the horizon runs out, which means the
 * workspace has more queued posts than slots for the next four months. The
 * caller should say so rather than silently scheduling nothing.
 */
export function nextFreeSlots(options: {
  slots: readonly Slot[]
  timezone: string
  /** Instants already spoken for. Compared to the millisecond. */
  taken: readonly Date[]
  from: Date
  count: number
}): Date[] {
  const { slots, timezone, taken, from, count } = options
  if (slots.length === 0 || count <= 0) return []

  const spoken = new Set(taken.map((date) => date.getTime()))
  const found: Date[] = []

  // Walk forward a day at a time in the WORKSPACE's calendar, not the server's.
  // A server in Los Angeles deciding what "Tuesday" means for a workspace in
  // Auckland is wrong for most of the day.
  const cursor = new Date(from.getTime())

  for (let day = 0; day <= HORIZON_DAYS && found.length < count; day++) {
    const local = localParts(cursor, timezone)
    const todays = slots
      .filter((slot) => slot.dayOfWeek === local.weekday)
      .sort((a, b) => a.hour - b.hour || a.minute - b.minute)

    for (const slot of todays) {
      const at = zonedTimeToUtc(local.year, local.month, local.day, slot.hour, slot.minute, timezone)

      // Strictly after `from`: a slot at 09:00 is no use at 09:30, and handing
      // out a past instant makes the scheduler publish it immediately.
      if (at.getTime() <= from.getTime()) continue
      if (spoken.has(at.getTime())) continue
      if (found.some((existing) => existing.getTime() === at.getTime())) continue

      found.push(at)
      if (found.length >= count) break
    }

    cursor.setTime(cursor.getTime() + 86_400_000)
  }

  return found
}

/** The local calendar date and weekday of an instant, in a given zone. */
function localParts(
  instant: Date,
  timezone: string
): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant)

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdays[get('weekday')] ?? 0,
  }
}

/** "Tue 09:00", for a list a person reads. */
export function describeSlot(slot: Slot): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[slot.dayOfWeek] ?? '?'} ${String(slot.hour).padStart(2, '0')}:${String(
    slot.minute
  ).padStart(2, '0')}`
}

/**
 * A sensible starting queue for a workspace that has none.
 *
 * Weekday mornings and one mid-afternoon. Offered as a one-click starting
 * point rather than created silently — a queue nobody chose, publishing at
 * times nobody picked, is worse than an empty one.
 */
export const SUGGESTED_SLOTS: readonly Slot[] = [
  { dayOfWeek: 1, hour: 9, minute: 0 },
  { dayOfWeek: 2, hour: 9, minute: 0 },
  { dayOfWeek: 3, hour: 9, minute: 0 },
  { dayOfWeek: 4, hour: 9, minute: 0 },
  { dayOfWeek: 5, hour: 9, minute: 0 },
  { dayOfWeek: 2, hour: 15, minute: 30 },
  { dayOfWeek: 4, hour: 15, minute: 30 },
]
