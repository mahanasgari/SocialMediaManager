'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

export type CalendarEntry = {
  id: string
  status: string
  excerpt: string
  at: string | null
  timezone: string
  channels: string[]
  summary: string
}

export type CalendarView = 'month' | 'week' | 'day' | 'list'

const DAY_MS = 86_400_000
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The content calendar, in four readings of the same data.
 *
 * Built directly rather than on a general event-calendar library: a content
 * calendar diverges from one quickly — per-channel status, partial publishing,
 * drag-to-reschedule with a server round trip — and fighting a library's event
 * model costs more than the grid does.
 *
 * The four views answer genuinely different questions, which is why all four
 * exist rather than one configurable grid. Month is "is next month full?";
 * week is "what does this week look like?"; day is "what goes out today?"; and
 * list is "what is coming next, in order?" — the only one that survives a
 * sparse calendar, where a grid is thirty empty squares and four posts you have
 * to hunt for.
 *
 * Everything renders in the VIEWER'S timezone. The instant is absolute; the
 * author's zone travels with it so "9am" can be shown as the author meant it
 * where that matters.
 */
export function Calendar({
  workspaceId,
  entries,
  view,
  anchor: anchorIso,
}: {
  workspaceId: string
  entries: CalendarEntry[]
  view: CalendarView
  anchor: string
}) {
  const router = useRouter()
  const [dragging, setDragging] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const anchor = useMemo(() => new Date(anchorIso), [anchorIso])

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (!entry.at) continue
      const key = dayKey(new Date(entry.at))
      map.set(key, [...(map.get(key) ?? []), entry])
    }
    // Within a day, chronological. A cell listing 17:00 above 09:00 reports the
    // same facts in an order nobody reads them in.
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime())
    }
    return map
  }, [entries])

  async function reschedule(postId: string, day: Date) {
    setError(null)
    const original = entries.find((e) => e.id === postId)
    // Keep the time of day and move only the date — dropping a 9am post onto
    // Thursday should make it 9am Thursday, not midnight.
    const previous = original?.at ? new Date(original.at) : new Date()
    const next = new Date(day)
    next.setHours(previous.getHours(), previous.getMinutes(), 0, 0)

    const response = await fetch(`/api/v1/calendar/${postId}/reschedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, scheduledAt: next.toISOString() }),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'Could not reschedule that post.')
      return
    }
    router.refresh()
  }

  /** The days the grid views render. */
  const days = useMemo(() => {
    if (view === 'day') return [startOfDay(anchor)]
    if (view === 'week') {
      const offset = (anchor.getDay() + 6) % 7
      const start = new Date(startOfDay(anchor).getTime() - offset * DAY_MS)
      return Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS))
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7
    const start = new Date(first.getTime() - offset * DAY_MS)
    return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY_MS))
  }, [anchor, view])

  const step = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day'

  const chip = (entry: CalendarEntry) => (
    <div
      key={entry.id}
      draggable={entry.status !== 'PUBLISHED' && entry.status !== 'PARTIALLY_PUBLISHED'}
      onDragStart={() => setDragging(entry.id)}
      onDragEnd={() => setDragging(null)}
      title={`${entry.summary}\n${entry.channels.join(', ')}`}
      className="cursor-grab rounded px-1.5 py-1 text-[11px] leading-tight"
      style={{ background: toneFor(entry.status), color: 'hsl(var(--foreground))' }}
    >
      <span className="block truncate font-medium">
        {entry.at
          ? new Date(entry.at).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })
          : ''}
      </span>
      <span className="block truncate">{entry.excerpt || '(empty)'}</span>
    </div>
  )

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <NavLink workspaceId={workspaceId} view={view} date={shift(anchor, step, -1)} label="←" />
          <NavLink workspaceId={workspaceId} view={view} date={new Date()} label="Today" />
          <NavLink workspaceId={workspaceId} view={view} date={shift(anchor, step, 1)} label="→" />
          <p className="ml-1 text-sm font-medium">{heading(anchor, view)}</p>
        </div>

        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {(['month', 'week', 'day', 'list'] as const).map((option) => (
            <a
              key={option}
              href={`/w/${workspaceId}/calendar?view=${option}&date=${isoDate(anchor)}`}
              className="rounded px-2 py-1 text-xs capitalize transition-colors"
              style={
                option === view
                  ? { background: 'hsl(var(--primary) / 0.1)', color: 'hsl(var(--primary))' }
                  : { color: 'hsl(var(--muted-foreground))' }
              }
            >
              {option}
            </a>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-2 text-sm" role="alert">
          {error}
        </p>
      )}

      {view === 'list' ? (
        <ListView entries={entries} chip={chip} />
      ) : (
        <div
          className="grid gap-px overflow-hidden rounded-lg border"
          style={{
            gridTemplateColumns: `repeat(${view === 'day' ? 1 : 7}, minmax(0, 1fr))`,
            borderColor: 'hsl(var(--border))',
            background: 'hsl(var(--border))',
          }}
        >
          {(view === 'day' ? [WEEKDAYS[(anchor.getDay() + 6) % 7]!] : WEEKDAYS).map((label) => (
            <div
              key={label}
              className="bg-card px-2 py-1 text-center text-[11px] font-medium text-muted-foreground"
            >
              {label}
            </div>
          ))}

          {days.map((day) => {
            const key = dayKey(day)
            const forDay = byDay.get(key) ?? []
            const otherMonth = view === 'month' && day.getMonth() !== anchor.getMonth()
            const isToday = key === dayKey(new Date())

            return (
              <div
                key={key}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragging) void reschedule(dragging, day)
                  setDragging(null)
                }}
                // Week and day get room to breathe; a month cell cannot.
                className={view === 'month' ? 'min-h-24 p-1' : 'min-h-64 p-1.5'}
                style={{
                  background: 'hsl(var(--background))',
                  opacity: otherMonth ? 0.45 : 1,
                }}
              >
                <div className="flex items-center justify-between px-1">
                  <span
                    className="text-[11px] tabular-nums"
                    style={{
                      color: isToday ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                      fontWeight: isToday ? 600 : 400,
                    }}
                  >
                    {view === 'month'
                      ? day.getDate()
                      : day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </span>
                  {forDay.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">{forDay.length}</span>
                  )}
                </div>

                <div className="mt-1 space-y-1">{forDay.map(chip)}</div>
              </div>
            )
          })}
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Drag a scheduled post to another day to move it. Published posts cannot be moved — they
        already exist on the network.
      </p>
    </>
  )
}

/**
 * Chronological, grouped by day.
 *
 * The view that survives a sparse calendar, and the one worth defaulting to
 * once a workspace has fewer posts than days.
 */
function ListView({
  entries,
  chip,
}: {
  entries: CalendarEntry[]
  chip: (entry: CalendarEntry) => React.ReactNode
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (!entry.at) continue
      const key = dayKey(new Date(entry.at))
      map.set(key, [...(map.get(key) ?? []), entry])
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => ({
        key,
        list: list.sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime()),
      }))
  }, [entries])

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
        Nothing scheduled in the next two months.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {groups.map(({ key, list }) => (
        <div key={key}>
          <p className="text-xs font-medium text-muted-foreground">
            {new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
          <div className="mt-1.5 space-y-1">{list.map(chip)}</div>
        </div>
      ))}
    </div>
  )
}

function NavLink({
  workspaceId,
  view,
  date,
  label,
}: {
  workspaceId: string
  view: CalendarView
  date: Date
  label: string
}) {
  return (
    <a
      href={`/w/${workspaceId}/calendar?view=${view}&date=${isoDate(date)}`}
      className="rounded border border-border px-2 py-1 text-xs"
    >
      {label}
    </a>
  )
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function dayKey(date: Date): string {
  return isoDate(date)
}

/** Steps the anchor by one unit of whatever the current view shows. */
function shift(anchor: Date, step: 'month' | 'week' | 'day', by: number): Date {
  if (step === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + by, 1)
  return new Date(anchor.getTime() + by * (step === 'week' ? 7 : 1) * DAY_MS)
}

function heading(anchor: Date, view: CalendarView): string {
  if (view === 'day') {
    return anchor.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  }
  if (view === 'week') {
    const offset = (anchor.getDay() + 6) % 7
    const start = new Date(startOfDay(anchor).getTime() - offset * DAY_MS)
    const end = new Date(start.getTime() + 6 * DAY_MS)
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    return `${fmt(start)} – ${fmt(end)}`
  }
  if (view === 'list') return 'Next 60 days'
  return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function toneFor(status: string): string {
  switch (status) {
    case 'PUBLISHED':
      return 'hsl(var(--primary) / 0.15)'
    case 'PARTIALLY_PUBLISHED':
    case 'NEEDS_REVIEW':
    case 'MISSED':
    case 'FAILED':
      return 'hsl(38 92% 50% / 0.2)'
    default:
      return 'hsl(var(--foreground) / 0.07)'
  }
}
